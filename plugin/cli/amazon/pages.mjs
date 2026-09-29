// amazon.de pages as the hidden Chrome returns them (DOM.getOuterHTML), read
// in Node. Shapes come from the Amazon discovery spike (#8, branch
// prototype/amazon-discovery, spikes/amazon/FINDINGS.md): the order history
// lists one "Lieferung verfolgen" link per Shipment, and each tracker page
// carries a language-independent `page-state` JSON. CSS milestone selectors
// were absent on the live page and are not used.
import { imageHost, normalizeImageUrl } from "../images.mjs";

export const ORIGIN = "https://www.amazon.de";
export const HISTORY_URL = `${ORIGIN}/gp/css/order-history?ref_=nav_orders_first`;

// The history page's own "Alle Bestellungen durchsuchen" form (GET, opt=ab):
// its results come back in the order history's markup.
export const orderSearchUrl = (orderId) => `${ORIGIN}/your-orders/search/ref=ppx_yo2ov_dt_b_search?opt=ab&search=${encodeURIComponent(orderId)}`;

export const orderDetailsUrl = (orderId) => `${ORIGIN}/your-orders/order-details?orderID=${encodeURIComponent(orderId)}`;

// Digital orders (audiobooks, Prime Video, subscriptions) have no tracker.
export const isDigitalOrder = (orderId) => /^D01-/.test(orderId);

// What a page is, before anything is parsed. Returns null for a normal page,
// or the Health reason that stops the account's run: "signed-out" for the
// sign-in page, "challenge" for OTP, MFA, CVF, captcha, WAF or ACIC pages, and
// "network" for Chrome's own error page. The history page itself links to
// /ap/signin and contains a `name="signIn"` form, so only the URL and markers
// that belong to the challenge pages alone are used.
const CHALLENGE_PATHS = [/^\/ap\/(mfa|cvf|challenge|dcq)/, /^\/ax\/aaut\//, /^\/errors\/validateCaptcha/];
const CHALLENGE_MARKERS = [
  /id="auth-mfa-form"/,
  /class="[^"]*cvf-widget-form/,
  /action="\/errors\/validateCaptcha/,
  /src="[^"]*awswaf\.com/,
  /\/ax\/aaut\/verify/,
  /id="auth-captcha-image"/,
];

export function classifyPage(url, html) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "network";
  }
  if (u.protocol === "chrome-error:") return "network";
  if (CHALLENGE_PATHS.some((re) => re.test(u.pathname))) return "challenge";
  if (CHALLENGE_MARKERS.some((re) => re.test(html))) return "challenge";
  if (/^\/ap\/signin/.test(u.pathname) || /id="ap_login_form"/.test(html)) return "signed-out";
  return null;
}

// The order history (or an order search result): one entry per Shipment with
// a tracker link, newest Order first, and the IDs of all Orders listed, with
// or without a tracker link. Returns { ok: true, shipments: [{ orderId,
// packageIndex, href, title, imageUrl }], orderIds: Set, stats } or { ok: false } when
// the page isn't the order history (a changed data format).
//
// Two layouts, told apart by their containers (#64). The personal history
// has `.your-orders-content-container` with one `.a-box.delivery-box` per
// Shipment, items in `.product-image` and `.yohtmlc-product-title`. The
// Amazon Business history has `#yourOrderHistorySection` with one
// `#orderCardDeliveryBox` per Shipment, items as `img.itemImageSource` and
// the title as the item link's text. Tracker and order-details links are the
// same in both. The site header links to /ap/signin on both; classifyPage
// doesn't take that for a sign-in page.
//
// A box is its element, from its opening tag to the matching closing one
// (Chrome serialises well-formed HTML). The item image is looked for in the
// whole box, before or after the tracker link, and never outside it: the page
// goes on after the last box with recommendations and their own product
// images. Should the box's element not hold its tracker link (a markup
// change), the chunk up to the next box is used, with the image looked for
// before the link as before.
//
// An item image is an `<img>` inside `.product-image` or with class
// `itemImageSource` (any `<img>` in the box when there is none of those).
// Its URL is the first of `src`, `data-src`, `data-a-hires` and the first
// `srcset` entry that is a product image on Amazon's CDN: a lazy-loaded image
// has a placeholder in `src` (see images.mjs).
//
// `stats` is for the refresh's diagnostic line and holds no IDs or URLs:
// boxes found, boxes with an image URL, and how many image URLs in the boxes
// point at each host.
const HISTORY_PAGE = [/your-orders-content-container/, /id="yourOrderHistorySection"/];
const DELIVERY_BOX = /class="a-box delivery-box|id="orderCardDeliveryBox"/g;
const TRACKER_LINK = /href="([^"]*\/progress-tracker\/package[^"]*)"/;
const IMG_TAG = /<img\b[^>]*>/g;
const ITEM_IMAGE_CLASS = /\sclass="(?:[^"]*\s)?itemImageSource[\s"]/;
const PRODUCT_IMAGE = /class="product-image(?:\s[^"]*)?"/g;
const IMAGE_ATTRS = ["src", "data-src", "data-a-hires", "srcset"];
const PRODUCT_TITLE = /class="yohtmlc-product-title"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/;
const ITEM_LINK = /<a\b[^>]*\shref="(?:https:\/\/www\.amazon\.de)?\/(?:dp|gp\/product)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

export function parseHistory(html) {
  if (!HISTORY_PAGE.some((re) => re.test(html))) return { ok: false };
  const orderIds = new Set([...html.matchAll(/\/your-orders\/order-details\?orderID=([\w-]+)/g)].map((m) => m[1]));
  const shipments = [];
  const seen = new Set();
  const stats = { boxes: 0, withImage: 0, hosts: {} };
  const starts = [...html.matchAll(DELIVERY_BOX)].map((m) => html.lastIndexOf("<", m.index));
  starts.forEach((start, i) => {
    stats.boxes++;
    const chunk = html.slice(start, starts[i + 1] ?? html.length);
    const end = elementEnd(html, start);
    const element = end === null ? null : html.slice(start, end);
    const inElement = element !== null && TRACKER_LINK.test(element);
    const box = inElement ? element : chunk;
    const link = box.match(TRACKER_LINK);
    // The images to look at: the whole box, or what comes before its link.
    const scope = inElement ? box : link ? box.slice(0, link.index) : element ?? "";
    const image = itemImage(scope, stats.hosts);
    if (image) stats.withImage++;
    if (!link) return;
    const href = new URL(decodeEntities(link[1]), ORIGIN);
    const orderId = href.searchParams.get("orderId");
    const packageIndex = href.searchParams.get("packageIndex") ?? "0";
    if (!orderId || isDigitalOrder(orderId)) return;
    const key = `${orderId}#${packageIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    shipments.push({
      orderId, packageIndex, href: href.toString(),
      title: productTitle(box, inElement ? box : box.slice(0, link.index)),
      imageUrl: image,
    });
  });
  return { ok: true, shipments, orderIds, stats };
}

// Where the element whose opening tag starts at `start` ends (after its
// closing tag), or null when it never closes. Comments and scripts are skipped.
function elementEnd(html, start) {
  const name = html.slice(start).match(/^<([a-z][a-z0-9-]*)/i)?.[1];
  if (!name) return null;
  const re = new RegExp(`<!--[\\s\\S]*?-->|<script\\b[\\s\\S]*?<\\/script>|<(\\/?)${name}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].startsWith("<!--") || /^<script\b/i.test(m[0])) continue;
    if (m[1]) depth--;
    else if (!m[0].endsWith("/>")) depth++;
    if (depth === 0) return re.lastIndex;
  }
  return null;
}

// The first item image's product image URL in `scope`, or null. Counts the
// host of every image URL it looks at into `hosts`.
function itemImage(scope, hosts) {
  const tags = [...scope.matchAll(IMG_TAG)];
  const items = tags.filter((t) => ITEM_IMAGE_CLASS.test(t[0]) || insideProductImage(scope, t.index));
  let found = null;
  for (const [tag] of items.length > 0 ? items : tags) {
    for (const url of imageUrls(tag)) {
      hosts[imageHost(url)] = (hosts[imageHost(url)] ?? 0) + 1;
      found ??= normalizeImageUrl(url);
    }
  }
  return found;
}

// An `<img>` at `index` sits in a `.product-image` element that is still open.
function insideProductImage(scope, index) {
  const before = scope.slice(0, index);
  const opened = [...before.matchAll(PRODUCT_IMAGE)].at(-1);
  return Boolean(opened) && !before.slice(opened.index).includes("</div>");
}

// The candidate URLs of one `<img>` tag, in order of preference.
function imageUrls(tag) {
  const urls = [];
  for (const name of IMAGE_ATTRS) {
    const value = tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
    if (value === undefined) continue;
    const decoded = decodeEntities(value).trim();
    // A srcset's first entry is its URL up to the first space (a URL's
    // size token may itself hold a comma).
    const url = name === "srcset" ? decoded.split(/\s+/)[0].replace(/,$/, "") : decoded;
    if (url) urls.push(url);
  }
  return urls;
}

// An order search page that found nothing (#75). Since #59 every account
// searches for the Orders only mail knows, so most searches find nothing, and
// the answer need not be in the history's markup at all. Such a page is: at
// /your-orders/search, with the search's own header (the personal layout's
// `#searchOrdersInput` form, the Business layout's `#abYoSearchBar`) or a "no
// results" line, and no Order, delivery box or unrendered card on it. Anything
// else parseHistory can't read is not recognised.
const SEARCH_PATH = /^\/your-orders\/search(?:\/|$)/;
const SEARCH_MARKERS = [
  /id="searchOrdersInput"/,
  /id="abYoSearchBar"/,
  /action="\/your-orders\/search/,
  /keine\s+(?:passenden\s+)?(?:Bestellungen|Ergebnisse|Treffer)/i,
  /\b0\s+Bestellungen\b/i,
  /\bno\s+(?:matching\s+)?(?:orders|results)\b/i,
  /returned\s+no\s+results/i,
];
export function isEmptyOrderSearch(url, html) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (!SEARCH_PATH.test(path)) return false;
  if (!SEARCH_MARKERS.some((re) => re.test(html))) return false;
  if (/\/your-orders\/order-details\?orderID=/.test(html)) return false;
  if (new RegExp(DELIVERY_BOX.source).test(html) || SKELETON.test(html)) return false;
  return true;
}

// Whether a Business-layout history (or order search) page has rendered its
// order cards: the page ships `orderCard…Skeleton` placeholders first and
// fills them in client-side. `business` is false for any other page.
const SKELETON = /class="[^"]*\borderCard\w*Skeleton\b/;
export function renderState(html) {
  if (!/id="yourOrderHistorySection"/.test(html)) return { business: false };
  return { business: true, pending: SKELETON.test(html), boxes: (html.match(/id="orderCardDeliveryBox"/g) ?? []).length };
}

// `.yohtmlc-product-title` where there is one, else the first item link
// before the tracker link with text (the image's own link has none).
function productTitle(box, items) {
  const title = box.match(PRODUCT_TITLE);
  if (title) return cleanText(title[1]);
  for (const [, text] of items.matchAll(ITEM_LINK)) {
    const t = cleanText(text);
    if (t) return t;
  }
  return null;
}

// A progress-tracker page. Returns { ok: true, state, carrierText } with the
// parsed `page-state` JSON, or { ok: false } when it is missing (a changed data
// format, never an empty result).
export function parseTracker(html) {
  const scripts = html.matchAll(/<script[^>]*data-a-state="([^"]*)"[^>]*>([\s\S]*?)<\/script>/g);
  for (const [, attr, body] of scripts) {
    let key;
    try {
      key = JSON.parse(decodeEntities(attr)).key;
    } catch {
      continue;
    }
    if (key !== "page-state") continue;
    let state;
    try {
      state = JSON.parse(body);
    } catch {
      return { ok: false };
    }
    if (!state || typeof state.orderId !== "string") return { ok: false };
    return { ok: true, state, carrierText: carrierText(html) };
  }
  return { ok: false };
}

// The heading of the delivery card, e.g. "Versendet mit DHL" or "Versand durch
// Amazon", which sits right before "Trackingnummer …".
function carrierText(html) {
  const card = html.match(/class="pt-delivery-card-wrapper"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/);
  return card ? cleanText(card[1]) : null;
}

// Carrier from the page text when stated, else from the number format.
const CARRIER_TEXT = [
  { carrier: "Amazon Logistics", when: /\b(durch|by|von) Amazon\b|Amazon Logistics/i },
  { carrier: (m) => normalizeCarrier(m[1]), when: /(?:Versendet mit|Versand (?:mit|durch)|Zustellung durch|Shipped with|Delivered by|Delivery by)\s+(.+)$/i },
];
const CARRIER_NUMBER = [
  { carrier: "DHL", when: /^(00340\d+|JJD[A-Z0-9]+)$/ },
  { carrier: "Amazon Logistics", when: /^DE[A-Z0-9]{10}$/ },
];

function normalizeCarrier(name) {
  const n = name.trim();
  if (/^DHL\b/i.test(n) || /^Deutsche Post\b/i.test(n)) return "DHL";
  if (/^Amazon\b/i.test(n)) return "Amazon Logistics";
  return n;
}

export function inferCarrier(text, trackingNumber) {
  if (text) {
    for (const row of CARRIER_TEXT) {
      const m = text.match(row.when);
      if (m) return typeof row.carrier === "function" ? row.carrier(m) : row.carrier;
    }
  }
  if (trackingNumber) {
    const row = CARRIER_NUMBER.find((r) => r.when.test(trackingNumber));
    if (row) return row.carrier;
  }
  return null;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const cleanText = (s) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
