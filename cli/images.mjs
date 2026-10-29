// Item images on Shipment cards (#58; research: docs/research/amazon-item-images.md).
//
// An Amazon Shipment's `imageUrl` comes from its delivery box in the order
// history (amazon/pages.mjs). After the page run, each image not cached yet
// is fetched once over plain HTTPS from Amazon's public image CDN, never
// through Chrome and without cookies or a Referer, and kept as
// <state>/images/<imageId>.jpg. The URLs are immutable, so a cached file is
// never fetched again, and Shipments showing the same item share it. The
// Shipment gets `image` (the file's absolute path, all the card reads) only
// once the file is there; a failed fetch leaves it unset and is tried again on
// the next run. Files no Shipment references any more are deleted with the
// retention sweep and when a Connection goes.
import { chmod, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readState, updateState } from "./state.mjs";

// Amazon's image CDN hosts (all Amazon's own; any other host is never
// fetched). Pages link the same image IDs on any of them, over https or
// protocol-relative (never plain http), with or without a size token, as
// .jpg, .png, .gif or .webp. The size token between the image ID and the
// extension is rewritten to one 142 px square JPEG for every card.
const IMAGE_HOSTS = [
  "m.media-amazon.com",
  "images-eu.ssl-images-amazon.com",
  "images-na.ssl-images-amazon.com",
  "images-fe.ssl-images-amazon.com",
  "ecx.images-amazon.com",
  "g-ecx.images-amazon.com",
  "z-ecx.images-amazon.com",
];
const AMAZON_IMAGE = new RegExp(`^(?:https:)?//(${IMAGE_HOSTS.map((h) => h.replace(/[.-]/g, "\\$&")).join("|")})`
  + "/images/I/([A-Za-z0-9+%-]+)(?:\\.[^/?#]*)?\\.(?:jpe?g|png|gif|webp)(?:[?#][^\\s]*)?$", "i");
const SIZE = "_SS142_";
const MAX_BYTES = 200_000;
const TIMEOUT_MS = 10_000;
// Per run; the rest follow on later runs.
const MAX_FETCHES = 10;

const DIR = "images";
const imageId = (url) => url.match(AMAZON_IMAGE)?.[2] ?? null;
const pathFor = (stateDir, id) => join(stateDir, DIR, `${id}.jpg`);

// An image URL from the order history (`src`, `data-src`, `srcset`, …) → the
// imageUrl to keep, or null when it isn't a product image on Amazon's CDN
// (another host, a placeholder, a data: URI).
export function normalizeImageUrl(src) {
  const m = String(src ?? "").trim().match(AMAZON_IMAGE);
  return m ? `https://${m[1].toLowerCase()}/images/I/${m[2]}.${SIZE}.jpg` : null;
}

// The host an image URL points at, for the refresh's diagnostic line: a
// hostname, "data:", "relative" or "none". Never the path.
export function imageHost(src) {
  const s = String(src ?? "").trim();
  if (!s) return "none";
  if (/^data:/i.test(s)) return "data:";
  const m = s.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\/([a-z0-9.-]+)/i);
  return m ? m[1].toLowerCase() : "relative";
}

// Under the state lock: `images` ([{ key, imageUrl }], from one account's
// history) onto the Shipments that exist. A new image ID drops the old
// cached path, so the new one is fetched.
export function recordImageUrls(list, images) {
  for (const { key, imageUrl } of images) {
    const s = list.find((x) => x.key === key);
    if (!s || s.imageUrl === imageUrl) continue;
    s.imageUrl = imageUrl;
    delete s.image;
  }
}

const exists = (path) => stat(path).then(() => true, () => false);

// After a refresh's page runs (or a Login's first sync), outside the lock:
// fetches the images not cached yet, then records `image` under the lock.
export async function fetchImages({ stateDir, transport, log }) {
  const { shipments } = await readState(stateDir);
  const wanted = new Map();
  for (const s of shipments.shipments) {
    const id = s.imageUrl ? imageId(s.imageUrl) : null;
    if (!id || (s.image === pathFor(stateDir, id) && await exists(s.image))) continue;
    if (!wanted.has(id)) wanted.set(id, s.imageUrl);
  }
  if (wanted.size === 0) return;

  const ready = new Set();
  let fetched = 0;
  let failed = 0;
  for (const [id, url] of wanted) {
    if (await exists(pathFor(stateDir, id))) {
      ready.add(id);
      continue;
    }
    if (fetched + failed >= MAX_FETCHES) continue;
    if (await download(stateDir, id, url, transport)) {
      ready.add(id);
      fetched++;
    } else {
      failed++;
    }
  }
  if (ready.size > 0) {
    await updateState(stateDir, ({ shipments }) => {
      for (const s of shipments.shipments) {
        const id = s.imageUrl ? imageId(s.imageUrl) : null;
        if (id && ready.has(id)) s.image = pathFor(stateDir, id);
      }
    });
  }
  if (fetched || failed) log(`refresh: ${fetched} image(s) fetched${failed ? `, ${failed} failed` : ""}`);
}

// One image, or false. Images are cosmetic: no failure ever stops a run.
async function download(stateDir, id, url, transport) {
  let r;
  try {
    r = await transport.fetchBytes(url, { maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS });
  } catch {
    return false;
  }
  const bytes = r?.bytes;
  if (r?.status !== 200 || !/^image\/jpeg\b/i.test(r.contentType ?? "") || !bytes) return false;
  if (bytes.length > MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return false;
  const dir = join(stateDir, DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = pathFor(stateDir, id);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    return true;
  } catch {
    await rm(tmp, { force: true });
    return false;
  }
}

// Under the state lock: deletes the cached files that no Shipment shows or
// is about to fetch.
export async function removeUnusedImages(stateDir, shipments) {
  const dir = join(stateDir, DIR);
  let names;
  try {
    names = await readdir(dir);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  const used = new Set(shipments.shipments.map((s) => (s.imageUrl ? imageId(s.imageUrl) : null)).filter(Boolean));
  for (const name of names) {
    if (!used.has(name.split(".")[0])) await rm(join(dir, name), { force: true });
  }
}
