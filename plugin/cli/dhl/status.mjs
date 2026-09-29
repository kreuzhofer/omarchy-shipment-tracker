// A DHL element → Status and Estimate, as data (spec #21, "Status mapping").
// STATUS_RULES: the first matching row wins. PICKUP_PLACES, PROBLEM_TEXTS and
// PICKUP_DEADLINE hold the wording the spec marks "to be confirmed" (#17):
// new evidence slots in as rows, not as control flow.
import { dayLabel, windowText } from "../estimate.mjs";

const details = (e) => e?.sendungsdetails ?? {};
const verlauf = (e) => details(e).sendungsverlauf;
const zustellung = (e) => details(e).zustellung ?? {};
const progress = (e) => verlauf(e)?.fortschritt;
const lastEvent = (e) => verlauf(e)?.events?.at(-1);
// The short status line and the last event's text, where DHL words pickups and problems.
const texts = (e) => [verlauf(e)?.status, lastEvent(e)?.status].filter(Boolean);
const saysAny = (e, pattern) => texts(e).some((t) => pattern.test(t));

const isDelivered = (e) => details(e).istZugestellt === true;
// `retoure`/`ruecksendung` on the element per the spec; the spike also saw a
// per-event `ruecksendung` flag, so a return marked on the last event counts too.
const isReturn = (e) => details(e).retoure === true || details(e).ruecksendung === true || lastEvent(e)?.ruecksendung === true;
const atTopOfLadder = (e) => verlauf(e).maximalFortschritt > 0 && progress(e) === verlauf(e).maximalFortschritt;

// Problem wording, first match wins; the text is what the row shows as its Estimate.
const PROBLEM_TEXTS = [
  { pattern: /nicht zugestellt|Zustellversuch|nicht angetroffen/i, text: "Delivery attempt failed" },
  { pattern: /Adresse|Anschrift/i, text: "Address problem" },
  { pattern: /beschädigt/i, text: "Damaged" },
];
const UNPLAUSIBLE_TEXT = "DHL reports inconsistent data";
const problemText = (e) => {
  const row = PROBLEM_TEXTS.find((r) => saysAny(e, r.pattern));
  if (row) return row.text;
  return details(e).unplausibel === true ? UNPLAUSIBLE_TEXT : null;
};

// Where a Ready for pickup Shipment waits, from the text ("Packstation 142"),
// else from the flag that marked it.
const PICKUP_PLACES = /\b(Packstation|Postfiliale|Filiale|Paketshop|Paketbox|Poststation)(?:\s+(\d+))?/i;
const PICKUP_FLAGS = [
  { when: (e) => Boolean(zustellung(e).packageStationType), place: "Packstation" },
  { when: (e) => zustellung(e).benachrichtigtInFiliale === true, place: "Filiale" },
];
// "bis zum 06.10.2026", "bis 05.10." (year from the event date).
const PICKUP_DEADLINE = /\bbis(?:\s+(?:zum|spätestens))?\s+(\d{1,2})\.(\d{1,2})\.(\d{4})?/i;

const STATUS_RULES = [
  // The spec's "element without sendungsverlauf". The anonymous lookup of a
  // number DHL doesn't know does carry a sendungsverlauf (fortschritt 0, no
  // events) but flags it with sendungNichtGefunden, as seen live in #7.
  { status: "Unknown", when: (e) => !verlauf(e) || Boolean(e.sendungNichtGefunden) },
  { status: "Returned", when: (e) => isReturn(e) && isDelivered(e) },
  { status: "Delivered", when: isDelivered },
  { status: "Returning", when: isReturn },
  // Overrides the ladder, including its top step: a parcel in a Packstation
  // can read 5/5 before it is collected.
  {
    status: "Ready for pickup",
    when: (e) => zustellung(e).abholcodeAvailable === true || PICKUP_FLAGS.some((f) => f.when(e)) || saysAny(e, /abhol/i),
  },
  { status: "Problem", when: (e) => problemText(e) !== null },
  { status: "Delivered", when: atTopOfLadder },
  { status: "Out for delivery", when: (e) => progress(e) === 4 },
  { status: "In transit", when: (e) => progress(e) === 2 || progress(e) === 3 },
  { status: "Announced", when: (e) => progress(e) === 0 || progress(e) === 1 },
];

const statusDay = (e) => (verlauf(e)?.datumAktuellerStatus ?? lastEvent(e)?.datum ?? "").slice(0, 10) || null;

function deliveryWindow(e) {
  const { zustellzeitfensterVon: from, zustellzeitfensterBis: to } = zustellung(e);
  if (!from && !to) return null;
  return { from: from ?? to, to: to ?? from, text: windowText(from ?? to, to ?? from) };
}

function pickupEstimate(e) {
  let place = null;
  for (const t of texts(e).reverse()) {
    const m = t.match(PICKUP_PLACES);
    if (m) { place = m[2] ? `${m[1]} ${m[2]}` : m[1]; break; }
  }
  place ??= PICKUP_FLAGS.find((f) => f.when(e))?.place ?? "Ready for pickup";
  let deadline = null;
  for (const t of texts(e).reverse()) {
    const m = t.match(PICKUP_DEADLINE);
    if (m) {
      const year = m[3] ?? (statusDay(e) ?? "").slice(0, 4);
      if (year) deadline = `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
      break;
    }
  }
  return { from: null, to: deadline, text: deadline ? `${place} · until ${dayLabel(deadline)}` : place };
}

const onDay = (verb) => (e) => {
  const day = statusDay(e);
  return day ? { from: day, to: day, text: `${verb} ${dayLabel(day)}` } : { from: null, to: null, text: verb };
};

// Estimate per Status. Ready for pickup: place and deadline; Problem: what's
// wrong; Terminal: the day it happened; otherwise DHL's delivery window.
const ESTIMATES = {
  Unknown: () => ({ from: null, to: null, text: "Not known to DHL yet" }),
  "Ready for pickup": pickupEstimate,
  Problem: (e) => ({ from: null, to: null, text: problemText(e) }),
  Delivered: onDay("Delivered"),
  Returned: onDay("Returned"),
};

// Returns what DHL says about the Shipment, or null when no rule matches
// (a changed data format). `window` is the delivery window's end, the value
// Delayed is judged on (null when DHL gives none).
export function readDhlElement(element) {
  const rule = STATUS_RULES.find((r) => r.when(element));
  if (!rule) return null;
  const estimate = (ESTIMATES[rule.status] ?? deliveryWindow)(element);
  const window = ESTIMATES[rule.status] ? null : estimate?.to ?? null;
  return {
    status: rule.status,
    estimate,
    window,
    title: element.sendungsinfo?.sendungsname || null,
  };
}
