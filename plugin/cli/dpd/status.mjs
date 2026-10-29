// DPD's tracking page (dpd/search.mjs) → Status and Estimate, as data (#83).
// The page is server-rendered ASP.NET; the parse targets are its stable
// element ids: the delivery status line (`repParcelList_labDeliveryStatus_0`,
// "In Zustellung - 29.10.2026"), the status picture (`imgParcelStatus`,
// `images/status_<1..5>.svg`) and the steps of the parcel ladder
// (`labStatus<Step>`, each with a `labStatus<Step>Date` sibling holding
// "DD.MM." once reached, empty before).
//
// The status line wins where it says what the ladder can't (a return, a
// pickup, a problem: STATUS_TEXTS, first match). Wording DPD uses for those
// hasn't been seen yet; what is here is inferred, and new evidence slots in
// as rows. Any other status line, known or not, leaves the Status to the
// furthest step reached, then to the picture. Only a page without any of
// these elements is a changed data format (null).
import { dayLabel } from "../estimate.mjs";

const ID = "ContentPlaceHolder1_";
const DAY_MS = 864e5;

const cleanText = (html) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// The text of the element with this id, or null when the page has none.
function textOf(html, id) {
  const m = html.match(new RegExp(`<(\\w+)\\b[^>]*\\bid="${ID}${id}"[^>]*>([\\s\\S]*?)</\\1>`));
  return m ? cleanText(m[2]) : null;
}

// The status picture's number (1–5), or null.
function pictureOf(html) {
  const tag = html.match(new RegExp(`<img\\b[^>]*\\bid="${ID}imgParcelStatus"[^>]*>`))?.[0];
  const n = tag?.match(/\bsrc="[^"]*status_(\d)\.svg"/)?.[1];
  return n ? Number(n) : null;
}

// The steps in page order: [{ id, text, date }], date "DD.MM." or null.
function stepsOf(html) {
  const ids = [...html.matchAll(new RegExp(`\\bid="${ID}labStatus(\\w+?)"`, "g"))]
    .map((m) => m[1])
    .filter((id) => !id.endsWith("Date"));
  return [...new Set(ids)].map((id) => {
    const date = textOf(html, `labStatus${id}Date`)?.match(/^(\d{1,2})\.(\d{1,2})\./);
    return { id, text: textOf(html, `labStatus${id}`) ?? "", date: date ? date[0] : null };
  });
}

// How far each step is on the 5-step ladder: by its id, else by its wording
// (the last step's id wasn't recorded; "Paket zugestellt" names it).
const LADDER = { 1: "Announced", 2: "In transit", 3: "In transit", 4: "Out for delivery", 5: "Delivered" };
const STEP_IDS = { Start: 1, OnTheRoad: 2, DeliveryDepot: 3, CarLoad: 4, Delivered: 5 };
const STEP_TEXTS = [
  { rank: 5, when: /(?<!nicht )zugestellt/i },
  { rank: 4, when: /in Zustellung/i },
  { rank: 3, when: /Paketzustellzentrum|Depot/i },
  { rank: 2, when: /unterwegs/i },
  { rank: 1, when: /übergeben|Paketinfo/i },
];
const rankOf = (step) => STEP_IDS[step.id] ?? STEP_TEXTS.find((r) => r.when.test(step.text))?.rank ?? 0;

const PROBLEM_TEXTS = [
  { pattern: /nicht zugestellt|Zustellversuch|nicht angetroffen/i, text: "Delivery attempt failed" },
  { pattern: /Adresse|Anschrift/i, text: "Address problem" },
  { pattern: /beschädigt/i, text: "Damaged" },
];
const PICKUP_PLACES = /\b(Paketshop|Pickup Station|Packstation|Paketstation)\b/i;

// The status line's say, first match wins; null leaves it to the ladder.
const STATUS_TEXTS = [
  { status: "Returning", when: /Rücksendung|Retoure|zurück an den (?:Versender|Absender)/i },
  { status: "Delivered", when: /^(?!.*nicht zugestellt).*\bzugestellt\b/i },
  { status: "Ready for pickup", when: /Paketshop|Pickup|abhol/i },
  { status: "Problem", when: (t) => PROBLEM_TEXTS.some((r) => r.pattern.test(t)) },
  { status: "Out for delivery", when: /in Zustellung/i },
];
const matches = (when, text) => (typeof when === "function" ? when(text) : when.test(text));

// "29.10.2026" in the status line → "2026-10-29".
function lineDay(line) {
  const m = String(line ?? "").match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

// A step's "DD.MM." → "YYYY-MM-DD": this year, or last year when that day
// would lie more than a month ahead (a December step read in January).
function stepDay(date, now) {
  if (!date) return null;
  const [d, m] = date.split(".").map(Number);
  let year = now.getUTCFullYear();
  if (Date.UTC(year, m - 1, d) - now.getTime() > 30 * DAY_MS) year--;
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const onDay = (verb, day) => (day ? { from: day, to: day, text: `${verb} ${dayLabel(day)}` } : { from: null, to: null, text: verb });

// Returns what DPD says about the Shipment, or null for a page that isn't
// the tracking page any more. `window` is the Estimate's end, the value
// Delayed is judged on (null without one).
export function readDpdPage(html, now) {
  const page = String(html ?? "");
  const line = textOf(page, "repParcelList_labDeliveryStatus_0");
  const picture = pictureOf(page);
  const steps = stepsOf(page);
  if (line === null && picture === null && steps.length === 0) return null;

  const reached = steps.filter((s) => s.date);
  const top = reached.reduce((best, s) => (rankOf(s) > (best ? rankOf(best) : 0) ? s : best), null);
  const ladder = top && rankOf(top) > 0 ? LADDER[rankOf(top)] : picture ? LADDER[picture] ?? null : null;
  const said = line ? STATUS_TEXTS.find((r) => matches(r.when, line))?.status : undefined;
  const status = said ?? ladder ?? "Unknown";
  const topDay = top ? stepDay(top.date, now) : null;

  let estimate = null;
  if (status === "Unknown") estimate = { from: null, to: null, text: "Not known to DPD yet" };
  else if (status === "Delivered") estimate = onDay("Delivered", lineDay(line) ?? topDay);
  else if (status === "Ready for pickup") estimate = { from: null, to: null, text: line.match(PICKUP_PLACES)?.[1] ?? "Ready for pickup" };
  else if (status === "Problem") estimate = { from: null, to: null, text: PROBLEM_TEXTS.find((r) => r.pattern.test(line)).text };
  else if (status === "Out for delivery") {
    const day = lineDay(line) ?? (top && rankOf(top) === 4 ? topDay : null);
    if (day) estimate = { from: day, to: day, text: dayLabel(day) };
  }
  const windowed = status === "Out for delivery" && estimate !== null;
  return {
    status,
    estimate,
    window: windowed ? estimate.to : null,
    title: null,
    // The status line and every step's date: a new step or line within the
    // same Status changes it (see dismiss.mjs).
    trackingEvent: `${line ?? ""}|${steps.map((s) => s.date ?? "").join(",")}`,
  };
}
