// amazon.de mail → Order-level readings (spec #21, "Microsoft 365 mail"; the
// senders were confirmed live on #8). The sender decides the Status, as data;
// senders not in the table (payments, digital orders, promotions) and every
// DHL mail are ignored. Bodies give the Order ID and an estimate phrase, but
// no Carrier and no tracking number. Only what a reading needs is kept:
// nothing of a body is stored.
import { dayLabel } from "../estimate.mjs";
import { localDate, parseEstimate } from "../amazon/status.mjs";

const DOMAIN = "amazon.de";

// The sender's local part → Status. `rank` breaks ties between mails with
// the same timestamp: the further one wins.
export const SENDER_RULES = [
  { sender: "bestellbestaetigung", status: "Announced", rank: 0 },
  { sender: "versandbestaetigung", status: "In transit", rank: 1 },
  { sender: "shipment-tracking", status: "Out for delivery", rank: 2 },
  { sender: "order-update", status: "Delivered", rank: 3 },
];

const ORDER_ID = /\b\d{3}-\d{7}-\d{7}\b/g;
const WEEKDAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"];
// "Ankunft heute", "Ankunft Donnerstag", "Voraussichtliche Zustellung: Freitag, 2. Oktober",
// "Lieferung 6. – 8. Oktober".
const DAY = "(?:heute|morgen|übermorgen|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|\\d{1,2}\\.)";
const ESTIMATE = new RegExp(
  `\\b(?:ankunft|zustellung|lieferung)(?:\\s+voraussichtlich)?:?\\s+(?:am\\s+)?${DAY}(?:,?\\s*\\d{1,2}\\.)?(?:\\s*[a-zäöü]+)?(?:\\s*[-–]\\s*${DAY}(?:,?\\s*\\d{1,2}\\.)?(?:\\s*[a-zäöü]+)?)?`,
  "i",
);
const MONTH_WORD = /^(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)$/i;

const senderRule = (address) => {
  const [local, domain] = String(address ?? "").toLowerCase().split("@");
  return domain === DOMAIN ? SENDER_RULES.find((r) => r.sender === local) ?? null : null;
};

// The item as the subject names it: `Versendet: „Kaffeebohnen 1 kg...“` → `Kaffeebohnen 1 kg...`.
function subjectTitle(subject) {
  const text = String(subject ?? "").replace(/[​-‏‪-‮­͏]/g, "").trim();
  const item = text.includes(":") ? text.slice(text.indexOf(":") + 1) : text;
  return item.replace(/[„“”"«»]/g, "").replace(/\s+/g, " ").trim() || null;
}

// The phrase as Amazon wrote it, trimmed to the day (a trailing word that
// isn't a month belongs to the next line of the mail).
function estimatePhrase(body) {
  const match = String(body ?? "").match(ESTIMATE);
  if (!match) return null;
  const words = match[0].trim().split(/\s+/);
  const last = words.at(-1);
  if (words.length > 2 && /^[a-zäöü]+$/i.test(last) && !MONTH_WORD.test(last) && !WEEKDAYS.includes(last.toLowerCase())) words.pop();
  return words.join(" ");
}

// A weekday alone ("Ankunft Donnerstag") is the next such day on or after
// the day the mail came; the rest is read as on the Amazon tracker.
function readEstimate(phrase, received, timeZone) {
  if (!phrase) return null;
  const parsed = parseEstimate(phrase, received, timeZone);
  if (parsed.from) return parsed;
  const weekday = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`, "i").test(phrase));
  if (weekday < 0) return parsed;
  const day = new Date(`${localDate(received, timeZone)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + ((weekday - day.getUTCDay() + 7) % 7));
  const iso = day.toISOString().slice(0, 10);
  return { from: iso, to: iso, text: phrase };
}

// Graph messages (id, receivedDateTime, from, subject, body) received since
// `since` → { readings, ignored }. One reading per Order ID: the latest mail
// about it decides its Status; its title and estimate come from the latest
// mail that has one.
export function readMails(messages, since, timeZone) {
  const byOrder = new Map();
  let ignored = 0;
  for (const m of messages) {
    const received = Date.parse(m?.receivedDateTime);
    if (!Number.isFinite(received) || received < since.getTime()) continue;
    const rule = senderRule(m.from?.emailAddress?.address);
    const body = typeof m.body?.content === "string" ? m.body.content : "";
    const ids = [...new Set(`${m.subject ?? ""} ${body}`.match(ORDER_ID) ?? [])];
    if (!rule || ids.length === 0) {
      ignored++;
      continue;
    }
    const mail = { at: received, rule, title: subjectTitle(m.subject), estimate: readEstimate(estimatePhrase(body), new Date(received), timeZone) };
    for (const id of ids) byOrder.set(id, [...(byOrder.get(id) ?? []), mail]);
  }
  const readings = [...byOrder].map(([orderId, mails]) => {
    mails.sort((a, b) => (a.at - b.at) || (a.rule.rank - b.rule.rank));
    const latest = mails.at(-1);
    const status = latest.rule.status;
    const title = mails.map((x) => x.title).filter(Boolean).at(-1) ?? null;
    let estimate = mails.map((x) => x.estimate).filter(Boolean).at(-1) ?? null;
    if (status === "Delivered") {
      const day = localDate(new Date(latest.at), timeZone);
      estimate = { from: day, to: day, text: `Delivered ${dayLabel(day)}` };
    }
    return { orderId, status, title, estimate, window: status === "Delivered" ? null : estimate?.to ?? null };
  });
  return { readings, ignored };
}
