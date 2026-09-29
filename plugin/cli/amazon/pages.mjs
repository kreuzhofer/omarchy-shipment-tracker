// amazon.de pages as the hidden Chrome returns them (DOM.getOuterHTML), read
// in Node. Shapes come from the Amazon discovery spike (#8, branch
// prototype/amazon-discovery, spikes/amazon/FINDINGS.md): the order history
// lists one "Lieferung verfolgen" link per Shipment, and each tracker page
// carries a language-independent `page-state` JSON. CSS milestone selectors
// were absent on the live page and are not used.
export const ORIGIN = "https://www.amazon.de";
export const HISTORY_URL = `${ORIGIN}/gp/css/order-history?ref_=nav_orders_first`;

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

// The order history: one entry per Shipment with a tracker link, newest Order
// first. Returns { ok: true, shipments: [{ orderId, packageIndex, href, title }] }
// or { ok: false } when the page isn't the order history (a changed data format).
export function parseHistory(html) {
  if (!/your-orders-content-container/.test(html)) return { ok: false };
  const shipments = [];
  const seen = new Set();
  for (const box of html.split(/class="a-box delivery-box/).slice(1)) {
    const link = box.match(/href="([^"]*\/progress-tracker\/package[^"]*)"/);
    if (!link) continue;
    const href = new URL(decodeEntities(link[1]), ORIGIN);
    const orderId = href.searchParams.get("orderId");
    const packageIndex = href.searchParams.get("packageIndex") ?? "0";
    if (!orderId || isDigitalOrder(orderId)) continue;
    const key = `${orderId}#${packageIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = box.match(/class="yohtmlc-product-title"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/);
    shipments.push({ orderId, packageIndex, href: href.toString(), title: title ? cleanText(title[1]) : null });
  }
  return { ok: true, shipments };
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
