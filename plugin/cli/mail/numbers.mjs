// DHL tracking numbers in mail from any sender (#59): shop and eBay shipping
// confirmations name the number of a parcel DHL may not list under the
// user's name. A number counts only in a mail that mentions DHL, in one of
// DHL's own formats, behind a DHL tracking link, or right after a word like
// "Sendungsnummer". amazon.de mail is left to status.mjs: its Orders are
// read by the Amazon Source. Nothing of a mail is kept but the number and
// what the item ladder (item.mjs) extracts.

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

const domainOf = (address) => String(address ?? "").toLowerCase().split("@")[1] ?? "";
const isAmazon = (m) => /(^|\.)amazon\.de$/.test(domainOf(m.from?.emailAddress?.address));

// The DHL numbers one mail names, in order, without repeats.
export function numbersIn(text) {
  const found = [];
  for (const pattern of [...FORMATS, LINKS, LABELLED]) {
    for (const match of String(text ?? "").matchAll(pattern)) {
      const number = match[1].toUpperCase();
      if (PLAUSIBLE.test(number) && !found.includes(number)) found.push(number);
    }
  }
  return found;
}

// Graph messages received since `since` → [{ trackingNumber, message }], one
// per number: the latest mail that names it.
export function findNumbers(messages, since) {
  const byNumber = new Map();
  for (const m of messages) {
    const received = Date.parse(m?.receivedDateTime);
    if (!Number.isFinite(received) || received < since.getTime() || isAmazon(m)) continue;
    const body = typeof m.body?.content === "string" ? m.body.content : "";
    const text = `${m.subject ?? ""}\n${body}`;
    if (!MENTIONS_DHL.test(text) && !/(^|\.)dhl\.(de|com)$/.test(domainOf(m.from?.emailAddress?.address))) continue;
    for (const trackingNumber of numbersIn(text)) {
      const seen = byNumber.get(trackingNumber);
      if (!seen || Date.parse(seen.receivedDateTime) < received) byNumber.set(trackingNumber, m);
    }
  }
  return [...byNumber].map(([trackingNumber, message]) => ({ trackingNumber, message }));
}
