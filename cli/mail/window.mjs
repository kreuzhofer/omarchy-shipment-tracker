// A DPD Predict mail's delivery window (#83): "Ihr Paket kommt heute zwischen
// 13:31 und 15:31 Uhr", in the subject or the body. Mail enriches, it never
// decides: the window is kept on the Shipment (`mailWindow`) and stands in
// for the Estimate only while DPD's own page gives none, or only that day
// (withMailWindow), and only until the day is past.
import { localDate } from "../amazon/status.mjs";
import { windowText } from "../estimate.mjs";

const WINDOW = /zwischen\s+(\d{1,2})[:.](\d{2})\s*(?:Uhr\s+)?(?:und|bis|-|–)\s*(\d{1,2})[:.](\d{2})\s*Uhr/i;
const DATE = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/;
// Where the window can be: Announced to Out for delivery (not at a pickup
// place, with a problem, or on its way back).
const WINDOWED = new Set(["Announced", "In transit", "Out for delivery"]);

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const pad = (n) => String(n).padStart(2, "0");

// The window `text` names → { from, to } as local date-times
// ("2026-10-29T13:31:00"), or null. The day: a date written next to it, else
// "morgen", else the day the mail came (Predict mails come that morning;
// "heute").
export function predictWindow(text, receivedAt, timeZone) {
  const value = String(text ?? "");
  const m = value.match(WINDOW);
  if (!m) return null;
  const near = value.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80);
  const received = localDate(new Date(receivedAt), timeZone);
  const date = near.match(DATE);
  let day = received;
  if (date) day = `${date[3]}-${pad(date[2])}-${pad(date[1])}`;
  else if (/\bmorgen\b/i.test(near) && !/\bheute\b/i.test(near)) day = addDays(received, 1);
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  return { from: `${day}T${pad(h1)}:${pad(m1)}:00`, to: `${day}T${pad(h2)}:${pad(m2)}:00` };
}

// The Carrier's reading with the mail's window as its Estimate, where the
// reading has none or only that same day; otherwise the reading as it is.
// `today`: the local "yyyy-MM-dd". The window's end doesn't count towards
// Delayed (only the Carrier's own Estimate does).
export function withMailWindow(shipment, reading, today) {
  const w = shipment.mailWindow;
  if (!w?.from || !WINDOWED.has(reading.status)) return reading;
  const day = String(w.from).slice(0, 10);
  if (day < today) return reading;
  const e = reading.estimate;
  if (e?.from && !(e.from === day && e.to === day)) return reading;
  return { ...reading, estimate: { from: w.from, to: w.to, text: windowText(w.from, w.to) } };
}

// Keeps a Predict mail's window on the Shipment that holds its number and,
// for a Shipment whose Status comes from DPD, puts it in place of an
// Estimate DPD didn't give. A change counts as the row's last change.
export function applyMailWindow(shipment, window, now, timeZone) {
  shipment.mailWindow = window;
  if (shipment.source !== "DPD" && shipment.detail !== "DPD") return;
  const { estimate } = withMailWindow(shipment, { status: shipment.status, estimate: shipment.estimate }, localDate(now, timeZone));
  if (JSON.stringify(estimate) === JSON.stringify(shipment.estimate)) return;
  shipment.estimate = estimate;
  shipment.changedAt = now.toISOString();
}
