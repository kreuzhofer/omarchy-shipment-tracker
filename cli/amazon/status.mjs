// amazon.de tracker `page-state` → Status, as data: the first matching row
// wins. Only language-independent fields are used (spec #21, "Status mapping").
//
// Values marked `confirmed: false` were not seen live yet (the spike only saw
// DELIVERED). Rows with empty lists are the spec's "to be confirmed" rows: they
// match nothing until a recorded page shows the value, which then goes into
// the list together with a fixture test.
const milestone = (s) => s.progressTracker?.lastReachedMilestone ?? null;
const reached = (s) => s.progressTracker?.numberOfReachedMilestones ?? 0;
const NO_EXCEPTION = new Set([null, undefined, "", "NONE", "NOT_APPLICABLE"]);

export const STATUS_RULES = [
  { status: "Delivered", shortStatus: ["DELIVERED"], milestone: ["DELIVERED"], confirmed: true },
  // Not deliverable, back to Amazon.
  { status: "Returned", shortStatus: [], milestone: [], confirmed: false },
  { status: "Returning", shortStatus: [], milestone: [], confirmed: false },
  // Locker / Counter / Packstation wording not observed yet.
  { status: "Ready for pickup", shortStatus: [], milestone: [], confirmed: false },
  // The spec's rule is "exceptionStateIdentifier set"; its values are to be confirmed.
  { status: "Problem", when: (s) => !NO_EXCEPTION.has(s.exceptionStateIdentifier), confirmed: false },
  { status: "Out for delivery", shortStatus: ["OUT_FOR_DELIVERY"], milestone: ["OUT_FOR_DELIVERY"], confirmed: false },
  { status: "In transit", shortStatus: ["IN_TRANSIT", "SHIPPED"], milestone: ["SHIPPED", "IN_TRANSIT"], confirmed: false },
  { status: "Announced", shortStatus: ["ORDERED", "ORDER_PLACED", "NOT_SHIPPED", "PREPARING_FOR_SHIPMENT"], milestone: ["ORDERED", "ORDER_PLACED"], confirmed: false },
  // A tracker page without milestones.
  { status: "Unknown", when: (s) => reached(s) === 0 && !milestone(s), confirmed: true },
];

const matches = (rule, s) => rule.when
  ? rule.when(s)
  : rule.shortStatus.includes(s.shortStatus) || rule.milestone.includes(milestone(s));

// Returns { status, mapped } where `mapped` is false when no row matched: a
// milestone we haven't seen yet. Such a Shipment shows as Unknown with Amazon's
// own promise text, and the run logs how many there were.
export function amazonStatus(pageState) {
  const rule = STATUS_RULES.find((r) => matches(r, pageState));
  return rule ? { status: rule.status, mapped: true } : { status: "Unknown", mapped: false };
}

// promise.promiseMessage → Estimate { from, to, text }. The text is always kept
// as Amazon wrote it; from/to are ISO dates (a day window) when a German or
// English day could be read: "heute", "morgen", "9. September", "Dienstag,
// 6. Oktober", "6. – 8. Oktober", "October 6".
const MONTHS = {
  januar: 0, jänner: 0, january: 0, jan: 0, februar: 1, february: 1, feb: 1, märz: 2, march: 2, mär: 2, mar: 2,
  april: 3, apr: 3, mai: 4, may: 4, juni: 5, june: 5, jun: 5, juli: 6, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sept: 8, sep: 8, oktober: 9, october: 9, okt: 9, oct: 9, november: 10, nov: 10, dezember: 11, december: 11, dez: 11, dec: 11,
};

export function parseEstimate(text, now, timeZone) {
  if (!text) return null;
  const today = localDate(now, timeZone);
  const days = [];
  const lower = text.toLowerCase();
  if (/\b(heute|today)\b/.test(lower)) days.push(today);
  if (/\b(morgen|tomorrow)\b/.test(lower) && !/übermorgen/.test(lower)) days.push(addDays(today, 1));
  if (/übermorgen/.test(lower)) days.push(addDays(today, 2));
  // "6. – 8. Oktober": the first day borrows the month of the second.
  const range = lower.match(/(\d{1,2})\.\s*[-–]\s*(\d{1,2})\.\s*([a-zäöü]+)/);
  if (range && MONTHS[range[3]] !== undefined) {
    days.push(nearestDate(today, MONTHS[range[3]], Number(range[1])), nearestDate(today, MONTHS[range[3]], Number(range[2])));
  } else {
    for (const m of lower.matchAll(/(\d{1,2})\.\s*([a-zäöü]+)/g)) {
      if (MONTHS[m[2]] !== undefined) days.push(nearestDate(today, MONTHS[m[2]], Number(m[1])));
    }
    for (const m of lower.matchAll(/\b([a-z]+)\s+(\d{1,2})\b/g)) {
      if (MONTHS[m[1]] !== undefined) days.push(nearestDate(today, MONTHS[m[1]], Number(m[2])));
    }
  }
  days.sort();
  return { from: days[0] ?? null, to: days.at(-1) ?? null, text };
}

// The calendar date (YYYY-MM-DD) of `now` in the user's time zone.
export function localDate(now, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function localHour(now, timeZone) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Amazon leaves out the year: pick the one that puts the day closest to today.
function nearestDate(todayIso, month, day) {
  const year = Number(todayIso.slice(0, 4));
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  const candidates = [year - 1, year, year + 1].map((y) => Date.UTC(y, month, day));
  const best = candidates.reduce((a, b) => (Math.abs(b - today) < Math.abs(a - today) ? b : a));
  return new Date(best).toISOString().slice(0, 10);
}
