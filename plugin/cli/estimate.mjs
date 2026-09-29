// Estimate texts and comparison. Estimates carry the Carrier's own local dates
// ("2026-09-30") or date-times with offset ("2026-09-30T14:00:00+02:00"); the
// text uses the date and clock time as written, so no time zone math is needed.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-09-30" or "2026-09-30T…" → "Wed 30 Sep".
export function dayLabel(value) {
  const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[weekday]} ${d} ${MONTHS[m - 1]}`;
}

const clock = (value) => (String(value).length > 10 ? String(value).slice(11, 16) : null);

// A day or time window as the row shows it: "Wed 30 Sep", "Wed 30 Sep – Thu 1 Oct",
// "Tue 29 Sep 14:00–17:00".
export function windowText(from, to) {
  const sameDay = String(from).slice(0, 10) === String(to).slice(0, 10);
  const [a, b] = [clock(from), clock(to)];
  if (sameDay) return a && b && a !== b ? `${dayLabel(from)} ${a}–${b}` : dayLabel(from);
  return `${dayLabel(from)}${a ? ` ${a}` : ""} – ${dayLabel(to)}${b ? ` ${b}` : ""}`;
}

// Whether window end `a` is later than `b`, compared by the Carrier's local
// day first, then by clock time when both carry one.
export function endsLater(a, b) {
  const [dayA, dayB] = [String(a).slice(0, 10), String(b).slice(0, 10)];
  if (dayA !== dayB) return dayA > dayB;
  const [clockA, clockB] = [clock(a), clock(b)];
  return Boolean(clockA && clockB && clockA > clockB);
}
