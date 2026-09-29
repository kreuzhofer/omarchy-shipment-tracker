// amazon.de pages as the hidden Chrome returns them (DOM.getOuterHTML), read
// in Node. Shapes come from the Amazon discovery spike (#8, branch
// prototype/amazon-discovery, spikes/amazon/FINDINGS.md): the order history
// lists one "Lieferung verfolgen" link per Shipment, and each tracker page
// carries a language-independent `page-state` JSON. CSS milestone selectors
// were absent on the live page and are not used.
import { normalizeImageUrl } from "../images.mjs";

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
// packageIndex, href, title, imageUrl }], orderIds: Set } or { ok: false } when
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
// A box's items come before its tracker link; the last box's chunk runs on to
// the end of the page (recommendations, footer), so the image is the first
// item image before the link, or none (see images.mjs).
const HISTORY_PAGE = [/your-orders-content-container/, /id="yourOrderHistorySection"/];
const DELIVERY_BOX = /class="a-box delivery-box|id="orderCardDeliveryBox"/;
const ITEM_IMAGES = [
  /class="product-image(?:\s[^"]*)?"[^>]*>(?:(?!<\/div>)[\s\S])*?<img\b[^>]*?\ssrc="([^"]*)"/,
  /<img\b(?=[^>]*\sclass="(?:[^"]*\s)?itemImageSource[\s"])[^>]*?\ssrc="([^"]*)"/,
];
const PRODUCT_TITLE = /class="yohtmlc-product-title"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/;
const ITEM_LINK = /<a\b[^>]*\shref="(?:https:\/\/www\.amazon\.de)?\/(?:dp|gp\/product)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

export function parseHistory(html) {
  if (!HISTORY_PAGE.some((re) => re.test(html))) return { ok: false };
  const orderIds = new Set([...html.matchAll(/\/your-orders\/order-details\?orderID=([\w-]+)/g)].map((m) => m[1]));
  const shipments = [];
  const seen = new Set();
  for (const box of html.split(DELIVERY_BOX).slice(1)) {
    const link = box.match(/href="([^"]*\/progress-tracker\/package[^"]*)"/);
    if (!link) continue;
    const href = new URL(decodeEntities(link[1]), ORIGIN);
    const orderId = href.searchParams.get("orderId");
    const packageIndex = href.searchParams.get("packageIndex") ?? "0";
    if (!orderId || isDigitalOrder(orderId)) continue;
    const key = `${orderId}#${packageIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const items = box.slice(0, link.index);
    const image = firstMatch(items, ITEM_IMAGES);
    shipments.push({
      orderId, packageIndex, href: href.toString(), title: productTitle(box, items),
      imageUrl: image ? normalizeImageUrl(decodeEntities(image[1])) : null,
    });
  }
  return { ok: true, shipments, orderIds };
}

// The earliest match of any of `patterns` in `text`.
function firstMatch(text, patterns) {
  return patterns.map((re) => text.match(re)).filter(Boolean).sort((a, b) => a.index - b.index)[0] ?? null;
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
