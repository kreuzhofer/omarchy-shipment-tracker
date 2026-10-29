// DHL and DPD tracking numbers in mail from any sender (#59, #83): shop and
// eBay shipping confirmations name the number of a parcel DHL may not list
// under the user's name, and DPD's own "Predict" mails announce a parcel and
// its delivery window. A DHL number counts only in a mail that mentions DHL
// (or comes from dhl.de), in one of DHL's own formats, behind a DHL tracking
// link, or right after a word like "Sendungsnummer". A DPD number (14 digits)
// counts only in a mail that mentions DPD (or comes from dpd.de), behind a
// my.dpd.de link or on its own. amazon.de mail is left to status.mjs: its
// Orders are read by the Amazon Source. Nothing of a mail is kept but the
// number, the window and sender a Predict mail names, and what the item
// ladder (item.mjs) extracts.
import { predictWindow } from "./window.mjs";

// Formats that are DHL's whatever the words around them: DHL Paket's
// 20-digit numbers, Amazon-via-DHL `JJD…` numbers, and Deutsche Post / DHL
// international `XX123456789DE` numbers.
const FORMATS = [
  /\b(00340434\d{12})\b/g,
  /\b(JJD\d{16,22})\b/gi,
  /\b([A-Z]{2}\d{9}DE)\b/g,
];
// A DHL tracking link: `…/verfolgen.html?piececode=…` or `?idc=…`.
const LINKS = /dhl\.(?:de|com)\/[^\s"'<>]*?[?&](?:piececode|idc|tracking-id)=([A-Za-z0-9]{8,40})/gi;
// "Sendungsnummer: 123456789012", "Tracking number 00340434…".
const LABELLED = /\b(?:sendungsnummer|sendungs-nr\.?|trackingnummer|tracking-nummer|tracking number|tracking-id|paketnummer|sendungsverfolgungsnummer)\s*[:#]?\s*([A-Z0-9]{8,40})\b/gi;
const MENTIONS_DHL = /\bDHL\b/i;
// A number is digits, or letters and at least 8 digits: never a plain word.
const PLAUSIBLE = /^(?=(?:\D*\d){8})[A-Z0-9]{8,40}$/;

// DPD: links carry the number wrapped as `parcelno=<prefix><14 digits><YYYYMMDD>`
// (prefixes like MPS or B2C); the 14 digits are the number. In the text it
// stands on its own, e.g. under "Versender & Paketnummer:" next to the sender.
const DPD_LINKS = /[?&]parcelno=[A-Z0-9]{0,4}?(\d{14})(?:\d{8})?(?![0-9])/gi;
const DPD_DIGITS = /(?<![\d.,/-])(\d{14})(?![\d.,/-]?\d)/g;
const MENTIONS_DPD = /\bDPD\b/i;
const SENDER = /Versender\s*(?:&amp;|&|und)\s*Paketnummer\s*:?\s*([^\n\d][^\n]{0,79}?)[\s,(]*\b(\d{14})\b/i;

const domainOf = (address) => String(address ?? "").toLowerCase().split("@")[1] ?? "";
const isAmazon = (m) => /(^|\.)amazon\.de$/.test(domainOf(m.from?.emailAddress?.address));
const fromDomain = (m, pattern) => pattern.test(domainOf(m.from?.emailAddress?.address));

function collect(found, text, patterns) {
  for (const pattern of patterns) {
    for (const match of String(text ?? "").matchAll(pattern)) {
      const number = match[1].toUpperCase();
      if (PLAUSIBLE.test(number) && !found.includes(number)) found.push(number);
    }
  }
}

// The DHL numbers one mail names, in order, without repeats.
export function numbersIn(text) {
  const found = [];
  collect(found, text, [...FORMATS, LINKS, LABELLED]);
  return found;
}

// The DPD numbers one mail names, in order, without repeats.
export function dpdNumbersIn(text) {
  const found = [];
  collect(found, text, [DPD_LINKS, DPD_DIGITS]);
  return found;
}

// The sender a DPD mail names next to the number, or null.
function senderOf(text, trackingNumber) {
  const m = String(text ?? "").match(SENDER);
  if (!m || m[2] !== trackingNumber) return null;
  const name = m[1].replace(/\s+/g, " ").trim();
  return name.length >= 2 ? name : null;
}

// Graph messages received since `since` → [{ trackingNumber, carrier,
// message, window, sender }], one per number: the latest mail that names it.
// `window` (DPD: a Predict mail's delivery window, see window.mjs) and
// `sender` (DPD: the shop named next to the number) are null when the mail
// names none. A number a mail names for both Carriers is DPD's when it is 14
// digits.
export function findNumbers(messages, since, timeZone) {
  const byNumber = new Map();
  const seen = new Set();
  for (const m of messages) {
    const received = Date.parse(m?.receivedDateTime);
    if (!Number.isFinite(received) || received < since.getTime() || isAmazon(m)) continue;
    if (m.id && seen.has(m.id)) continue;
    if (m.id) seen.add(m.id);
    const body = typeof m.body?.content === "string" ? m.body.content : "";
    const text = `${m.subject ?? ""}\n${body}`;
    const numbers = new Map();
    if (MENTIONS_DHL.test(text) || fromDomain(m, /(^|\.)dhl\.(de|com)$/)) for (const n of numbersIn(text)) numbers.set(n, "DHL");
    if (MENTIONS_DPD.test(text) || fromDomain(m, /(^|\.)dpd\.(de|com)$/)) for (const n of dpdNumbersIn(text)) numbers.set(n, "DPD");
    for (const [trackingNumber, carrier] of numbers) {
      const prior = byNumber.get(trackingNumber);
      if (prior && Date.parse(prior.message.receivedDateTime) >= received) continue;
      byNumber.set(trackingNumber, {
        trackingNumber,
        carrier,
        message: m,
        window: carrier === "DPD" ? predictWindow(text, m.receivedDateTime, timeZone) : null,
        sender: carrier === "DPD" ? senderOf(text, trackingNumber) : null,
      });
    }
  }
  return [...byNumber.values()];
}
