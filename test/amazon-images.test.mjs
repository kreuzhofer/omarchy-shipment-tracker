// Product images on Amazon Shipment cards (#58, from the #54 research in
// docs/research/amazon-item-images.md). The order history's delivery box
// gives each Shipment its first item's image; after the page run the image
// is fetched once from Amazon's public CDN (no Chrome, no cookies) and cached
// in the state dir. All Order IDs, image IDs and titles are synthetic, and the
// fake CDN serves a tiny generated JPEG.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fakeChrome, fakeDhlAccount, fakeImageCdn, fixture, makeWorld, TINY_JPEG } from "./harness.mjs";
import { historyPage, RECOMMENDATIONS, trackerPage } from "./fixtures/amazon/pages.mjs";

const SPLIT = "331-0000000-0000001"; // one Order, two Shipments
const SINGLE = "332-0000000-0000002";
const CDN = "https://m.media-amazon.com/images/I/";
const img = (id, token = "_SS142_") => `${CDN}${id}.${token}.jpg`;

const TRACKERS = {
  [`${SPLIT}#0`]: trackerPage({ orderId: SPLIT, packageIndex: "0", shortStatus: "IN_TRANSIT" }),
  [`${SPLIT}#1`]: trackerPage({ orderId: SPLIT, packageIndex: "1", shortStatus: "IN_TRANSIT" }),
  [`${SINGLE}#0`]: trackerPage({ orderId: SINGLE, packageIndex: "0", shortStatus: "IN_TRANSIT" }),
};

const HISTORY = historyPage([
  { orderId: SPLIT, shipments: [
    // Two items in the first box: the first one's image stands for it.
    { packageIndex: 0, shipmentId: "Tsplit000", title: "Lampenschirm", image: img("11AaBbCcDdE", "_SS284_"),
      items: [{ title: "Glühbirne", image: img("22FfGgHhIiJ") }] },
    { packageIndex: 1, shipmentId: "Tsplit001", title: "Tischlampe", image: img("33KkLlMmNnO", "_AC_UL75_SR75,75_") },
  ] },
  // The last box on the page: its chunk runs into the recommendations.
  { orderId: SINGLE, shipments: [{ packageIndex: 0, shipmentId: "Tsingle00", title: "Wanduhr", image: img("44PpQqRrSsT") }] },
], { footer: RECOMMENDATIONS });

async function imagesWorld(t, routes = { history: HISTORY, trackers: TRACKERS }) {
  const cdn = fakeImageCdn();
  const world = await makeWorld({ chrome: fakeChrome(routes), transport: cdn });
  t.after(() => world.cleanup());
  return { world, cdn };
}

async function connect(world, label = "Personal") {
  assert.equal(await world.run("accounts", "add", label, "--accept-risk"), 0);
  assert.equal(await world.run("login", `amazon:${label}`), 0);
}

const imagesDir = (world) => join(world.stateDir, "images");
const cached = (world) => readdir(imagesDir(world)).then((names) => names.sort(), () => []);
const imageIds = (cdn) => cdn.requests.map((r) => r.url.match(/\/images\/I\/([^.]+)\./)[1]);

test("each box of a split Order gives its Shipment the box's first image, cached once in the state dir", async (t) => {
  const { world, cdn } = await imagesWorld(t);
  await connect(world);
  assert.equal(await world.run("refresh"), 0);

  const first = await world.shipment(`amazon:${SPLIT}#0`);
  const second = await world.shipment(`amazon:${SPLIT}#1`);
  assert.equal(first.imageUrl, img("11AaBbCcDdE"));
  assert.equal(second.imageUrl, img("33KkLlMmNnO"));
  assert.equal(first.image, join(imagesDir(world), "11AaBbCcDdE.jpg"));
  assert.equal(second.image, join(imagesDir(world), "33KkLlMmNnO.jpg"));
  assert.deepEqual(await readFile(first.image), TINY_JPEG);

  assert.deepEqual(await cached(world), ["11AaBbCcDdE.jpg", "33KkLlMmNnO.jpg", "44PpQqRrSsT.jpg"]);
  assert.equal((await stat(imagesDir(world))).mode & 0o777, 0o700);
  assert.equal((await stat(first.image)).mode & 0o777, 0o600);

  // Plain HTTPS at the one size, without cookies or a Referer.
  assert.deepEqual(imageIds(cdn).sort(), ["11AaBbCcDdE", "33KkLlMmNnO", "44PpQqRrSsT"]);
  for (const r of cdn.requests) {
    assert.match(r.url, /\._SS142_\.jpg$/);
    assert.deepEqual(Object.keys(r.headers).map((h) => h.toLowerCase()).filter((h) => h === "cookie" || h === "referer"), []);
  }
});

test("the last box takes its own image, never one from the recommendations after it", async (t) => {
  const history = historyPage([
    // A placeholder instead of a product image counts as none.
    { orderId: SPLIT, shipments: [{ packageIndex: 0, shipmentId: "Tsplit000", title: "Lampenschirm", image: "https://m.media-amazon.com/images/G/03/placeholder.svg" }] },
    // No image in the last box, then the page's carousel with product images.
    { orderId: SINGLE, shipments: [{ packageIndex: 0, shipmentId: "Tsingle00", title: "Wanduhr", image: null }] },
  ], { footer: RECOMMENDATIONS });
  const { world, cdn } = await imagesWorld(t, { history, trackers: TRACKERS });
  await connect(world);
  assert.equal(await world.run("refresh"), 0);

  const last = await world.shipment(`amazon:${SINGLE}#0`);
  assert.equal(last.title, "Wanduhr");
  assert.equal(last.imageUrl, undefined);
  assert.equal(last.image, undefined);
  assert.equal((await world.shipment(`amazon:${SPLIT}#0`)).imageUrl, undefined);
  assert.deepEqual(cdn.requests, []);

  // With an image of its own, the last box keeps it (see the split Order test).
  const { world: other } = await imagesWorld(t);
  await connect(other);
  assert.equal((await other.shipment(`amazon:${SINGLE}#0`)).imageUrl, img("44PpQqRrSsT"));
});

test("an image on any host but Amazon's image CDN is ignored and never fetched", async (t) => {
  const history = historyPage([
    { orderId: SPLIT, shipments: [{ packageIndex: 0, shipmentId: "Tsplit000", title: "Lampenschirm", image: "https://images.example.com/images/I/11AaBbCcDdE._SS142_.jpg" }] },
    { orderId: SINGLE, shipments: [{ packageIndex: 0, shipmentId: "Tsingle00", title: "Wanduhr", image: "http://m.media-amazon.com/images/I/44PpQqRrSsT._SS142_.jpg" }] },
  ]);
  const { world, cdn } = await imagesWorld(t, { history, trackers: TRACKERS });
  await connect(world);
  assert.equal(await world.run("refresh"), 0);

  for (const key of [`amazon:${SPLIT}#0`, `amazon:${SINGLE}#0`]) {
    const s = await world.shipment(key);
    assert.equal(s.imageUrl, undefined);
    assert.equal(s.image, undefined);
  }
  assert.deepEqual(cdn.requests, []);
  assert.deepEqual(await cached(world), []);
});

test("an image is downloaded once, however many runs and Shipments show it", async (t) => {
  const history = historyPage([
    { orderId: SPLIT, shipments: [
      { packageIndex: 0, shipmentId: "Tsplit000", title: "Socken", image: img("55UuVvWwXxY") },
      { packageIndex: 1, shipmentId: "Tsplit001", title: "Socken", image: img("55UuVvWwXxY") },
    ] },
  ]);
  const { world, cdn } = await imagesWorld(t, { history, trackers: TRACKERS });
  await connect(world);
  for (let i = 0; i < 3; i++) assert.equal(await world.run("refresh"), 0);

  assert.deepEqual(imageIds(cdn), ["55UuVvWwXxY"]);
  const path = join(imagesDir(world), "55UuVvWwXxY.jpg");
  assert.equal((await world.shipment(`amazon:${SPLIT}#0`)).image, path);
  assert.equal((await world.shipment(`amazon:${SPLIT}#1`)).image, path);
});

test("a failed download leaves the Shipment without an image and is tried again on the next run", async (t) => {
  const history = historyPage([{ orderId: SINGLE, shipments: [{ packageIndex: 0, shipmentId: "Tsingle00", title: "Wanduhr", image: img("44PpQqRrSsT") }] }]);
  const { world, cdn } = await imagesWorld(t, { history, trackers: TRACKERS });
  const key = `amazon:${SINGLE}#0`;
  const failures = [
    { network: true },
    { status: 503, contentType: "text/html", bytes: Buffer.from("<html>busy</html>") },
    { status: 200, contentType: "text/html", bytes: Buffer.from("<html>not an image</html>") },
    { status: 200, contentType: "image/jpeg", bytes: Buffer.from("not a jpeg") },
    { status: 200, contentType: "image/jpeg", bytes: Buffer.concat([TINY_JPEG, Buffer.alloc(300_000)]) },
  ];
  cdn.answer = () => failures.shift() ?? null;

  await connect(world);
  for (let i = 0; i < 4; i++) {
    assert.equal(await world.run("refresh"), 0);
    const s = await world.shipment(key);
    assert.equal(s.imageUrl, img("44PpQqRrSsT"));
    assert.equal(s.image, undefined, `after attempt ${i + 2}`);
    assert.deepEqual(await cached(world), []);
  }
  assert.equal(failures.length, 0);

  assert.equal(await world.run("refresh"), 0);
  assert.equal((await world.shipment(key)).image, join(imagesDir(world), "44PpQqRrSsT.jpg"));
  assert.equal(cdn.requests.length, 6);
  // The logs carry counts, never image IDs.
  assert.ok(!world.logs.join("\n").includes("44PpQqRrSsT"));
});

test("retention deletes image files that no Shipment references any more", async (t) => {
  const trackers = {
    ...TRACKERS,
    [`${SINGLE}#0`]: trackerPage({
      orderId: SINGLE, packageIndex: "0", shortStatus: "DELIVERED",
      progressTracker: { lastTransitionPercentComplete: 100, lastReachedMilestone: "DELIVERED", numberOfReachedMilestones: 4 },
      promise: { promiseMessage: "Zugestellt: 28. September" },
    }),
  };
  const { world } = await imagesWorld(t, { history: HISTORY, trackers });
  await connect(world);
  assert.equal(await world.run("refresh"), 0);
  assert.deepEqual(await cached(world), ["11AaBbCcDdE.jpg", "33KkLlMmNnO.jpg", "44PpQqRrSsT.jpg"]);

  // 31 days on, the Delivered Shipment is dropped; the history still lists it.
  world.setClock("2026-10-30T10:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);
  assert.equal(await world.shipment(`amazon:${SINGLE}#0`), undefined);
  assert.deepEqual(await cached(world), ["11AaBbCcDdE.jpg", "33KkLlMmNnO.jpg"]);
});

test("removing an Amazon account deletes its images along with its Shipments", async (t) => {
  const { world } = await imagesWorld(t);
  await connect(world);
  assert.equal(await world.run("refresh"), 0);
  assert.equal((await cached(world)).length, 3);

  assert.equal(await world.run("accounts", "remove", "Personal"), 0);
  assert.deepEqual((await world.shipmentsFile()).shipments, []);
  assert.deepEqual(await cached(world), []);
});

test("a merged Shipment that turns back into a DHL Shipment loses the Amazon image", async (t) => {
  const NUMBER = "00340434000000000331";
  const recorded = fixture("dhl/in-transit.json");
  const element = JSON.parse(JSON.stringify(recorded.sendungen[0]).replaceAll(recorded.sendungen[0].id, NUMBER));
  const list = { json: { sendungen: [element] } };
  const cdn = fakeImageCdn(fakeDhlAccount({ inbox: list, enrich: list }));
  const history = historyPage([{ orderId: SINGLE, shipments: [{ packageIndex: 0, shipmentId: "Tsingle00", title: "Wanduhr", image: img("44PpQqRrSsT") }] }]);
  const trackers = { [`${SINGLE}#0`]: trackerPage({ orderId: SINGLE, packageIndex: "0", shortStatus: "IN_TRANSIT", isMfn: true, trackingId: NUMBER }, { carrierLine: "Versendet mit DHL" }) };
  const world = await makeWorld({ chrome: fakeChrome({ history, trackers }), transport: cdn });
  t.after(() => world.cleanup());
  assert.equal(await world.run("login", "dhl"), 0);
  await connect(world);
  assert.equal((await world.shipment(`amazon:${SINGLE}#0`)).image, join(imagesDir(world), "44PpQqRrSsT.jpg"));

  assert.equal(await world.run("accounts", "remove", "Personal"), 0);
  const s = await world.shipment(`dhl:${NUMBER}`);
  assert.equal(s.source, "DHL");
  assert.equal(s.imageUrl, undefined);
  assert.equal(s.image, undefined);
  assert.deepEqual(await cached(world), []);
});
