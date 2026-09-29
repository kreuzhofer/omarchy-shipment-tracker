// DHL element → Status, as data: the first matching row wins. Rows the spec
// marks "to be confirmed" (Ready for pickup, Problem, Returning, Returned) slot
// in above the ladder as further rows.
const verlauf = (e) => e?.sendungsdetails?.sendungsverlauf;
const progress = (e) => verlauf(e)?.fortschritt;

const STATUS_RULES = [
  // The spec's "element without sendungsverlauf". The anonymous lookup of a
  // number DHL doesn't know does carry a sendungsverlauf (fortschritt 0, no
  // events) but flags it with sendungNichtGefunden, as seen live in #7.
  { status: "Unknown", when: (e) => !verlauf(e) || Boolean(e.sendungNichtGefunden) },
  { status: "Delivered", when: (e) => e.sendungsdetails.istZugestellt === true || (verlauf(e).maximalFortschritt > 0 && progress(e) === verlauf(e).maximalFortschritt) },
  { status: "Out for delivery", when: (e) => progress(e) === 4 },
  { status: "In transit", when: (e) => progress(e) === 2 || progress(e) === 3 },
  { status: "Announced", when: (e) => progress(e) === 0 || progress(e) === 1 },
];

const ESTIMATE_TEXT = { Unknown: "Not known to DHL yet" };

// Returns what DHL says about the Shipment, or null when no rule matches
// (a changed data format).
export function readDhlElement(element) {
  const rule = STATUS_RULES.find((r) => r.when(element));
  if (!rule) return null;
  const text = ESTIMATE_TEXT[rule.status];
  return {
    status: rule.status,
    estimate: text ? { from: null, to: null, text } : null,
    title: element.sendungsinfo?.sendungsname || null,
  };
}
