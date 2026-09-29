// What was shipped, from the mail that named a DHL number (#54's extraction
// ladder, docs/research/amazon-item-images.md). Each rung is tried in order
// and the first title wins:
//   1. schema.org ParcelDelivery markup (JSON-LD or microdata) in the HTML;
//   2. a parser for the sender, as data (eBay first);
//   3. the subject line.
// The opt-in agent step of the research is a later ticket. A rung that finds
// nothing falls through, never an error. Only { itemTitle, itemSource } is
// kept: the mail itself is read in memory and dropped.

const MAX_TITLE = 120;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", euro: "€", ndash: "–", mdash: "—" };
const decode = (text) => String(text ?? "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name] ?? m);

// Plain text, 1–120 characters (at least `min`), no URL: anything else is no title.
function validTitle(raw, min = 1) {
  const text = decode(String(raw ?? "").replace(/<[^>]*>/g, " "))
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮­]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < min || text.length > MAX_TITLE) return null;
  if (/https?:|www\.|\.(?:de|com)\//i.test(text)) return null;
  return text;
}

const types = (node) => [node?.["@type"]].flat().map((t) => String(t ?? "").replace(/^https?:\/\/schema\.org\//, ""));
const first = (value) => (Array.isArray(value) ? value[0] : value);

function* jsonLdNodes(html) {
  for (const m of String(html).matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(decode(m[1]));
    } catch {
      continue;
    }
    for (const node of [data].flat()) {
      yield node;
      for (const inner of [node?.["@graph"] ?? []].flat()) yield inner;
    }
  }
}

// 1. schema.org: a ParcelDelivery for this number (or naming none) and the
// name of what it shipped.
function fromSchema(html, trackingNumber) {
  for (const node of jsonLdNodes(html)) {
    if (!types(node).includes("ParcelDelivery")) continue;
    const number = node.trackingNumber ? String(node.trackingNumber).replace(/\s+/g, "").toUpperCase() : null;
    if (number && number !== trackingNumber) continue;
    const title = validTitle(first(node.itemShipped)?.name);
    if (title) return title;
  }
  // Microdata: <div itemscope itemtype="http://schema.org/ParcelDelivery">
  // … <div itemprop="itemShipped" itemscope …><span itemprop="name">…</span>.
  const at = String(html).search(/itemtype=["']https?:\/\/schema\.org\/ParcelDelivery["']/i);
  if (at < 0) return null;
  const scope = String(html).slice(at);
  const number = scope.match(/itemprop=["']trackingNumber["'][^>]*?(?:content=["']([^"']+)["'][^>]*>|>([^<]+)<)/i);
  const named = (number?.[1] ?? number?.[2] ?? "").replace(/\s+/g, "").toUpperCase();
  if (named && named !== trackingNumber) return null;
  const shipped = scope.slice(Math.max(0, scope.search(/itemprop=["']itemShipped["']/i)));
  if (!/itemprop=["']itemShipped["']/i.test(shipped)) return null;
  const name = shipped.match(/itemprop=["']name["'][^>]*?(?:content=["']([^"']+)["'][^>]*>|>([^<]+)<)/i);
  return validTitle(name?.[1] ?? name?.[2]);
}

// 2. Per-sender parsers, keyed on the sender's domain. The From domain can be
// spoofed; the worst a spoofed mail does is name a wrong item on a parcel
// DHL confirms. eBay's shipping mail links the item's listing (`/itm/<id>`)
// with the item's title as the link text (layout to verify on a real mail).
const PARSERS = [
  {
    domain: /(^|\.)ebay\.(de|com|co\.uk|at|fr|it|es)$/,
    parse(html) {
      for (const m of String(html).matchAll(/<a\b[^>]*href=["'][^"']*\/itm\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const title = validTitle(m[1], 3);
        if (title) return title;
      }
      return null;
    },
  },
];

// 3. The subject: what follows the colon of "Versendet: <item>", "Your item
// has shipped: <item>", without quotes, order numbers or the tracking number.
const GENERIC = /^(?:deine?|ihre?|your)?\s*(?:bestellung|order|sendung|paket|lieferung|artikel|item)\b/i;
function fromSubject(subject, trackingNumber) {
  const text = String(subject ?? "");
  if (!text.includes(":")) return null;
  const rest = text.slice(text.lastIndexOf(":") + 1)
    .replaceAll(trackingNumber, "")
    .replace(/\b(?:nr\.?|no\.?|#)?\s*[A-Z]{0,4}-?\d[\d-]{4,}\b/gi, "")
    .replace(/[„“”"«»]/g, "");
  const title = validTitle(rest, 3);
  return title && !GENERIC.test(title) ? title : null;
}

const domainOf = (address) => String(address ?? "").toLowerCase().split("@")[1] ?? "";

// A Graph message (`html`: its HTML body when it could be fetched) →
// { itemTitle, itemSource } or null.
export function itemInfo(message, trackingNumber, html = null) {
  if (html) {
    const schema = fromSchema(html, trackingNumber);
    if (schema) return { itemTitle: schema, itemSource: "schema" };
    const parser = PARSERS.find((p) => p.domain.test(domainOf(message.from?.emailAddress?.address)));
    const parsed = parser?.parse(html);
    if (parsed) return { itemTitle: parsed, itemSource: "parser" };
  }
  const subject = fromSubject(message.subject, trackingNumber);
  return subject ? { itemTitle: subject, itemSource: "subject" } : null;
}
