// Every DHL row of the spec's Status table (#21, "Status mapping") at the
// refresh seam, with the Estimate each one shows. Each case is a synthetic
// response: the in-transit fixture with the fields that DHL would change for
// that case. Values the spec marks "to be confirmed" (pickup location and
// deadline wording, the Problem word list, the return flags) are rows here too;
// when #17 records the real wording, add a case with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDhl, fixture, makeWorld } from "./harness.mjs";

const NUMBER = "00340434000000000066";

function response(patch) {
  const json = fixture("dhl/in-transit.json");
  const e = json.sendungen[0];
  e.id = NUMBER;
  e.sendungsinfo.gesuchteSendungsnummer = NUMBER;
  e.sendungsdetails.sendungsnummern.sendungsnummer = NUMBER;
  patch(e, e.sendungsdetails, e.sendungsdetails.sendungsverlauf, e.sendungsdetails.zustellung);
  return { json };
}

const lastEvent = (verlauf, status, extra = {}) => {
  verlauf.status = status;
  verlauf.datumAktuellerStatus = "2026-09-29T09:10:00+02:00";
  verlauf.events.push({ datum: "2026-09-29T09:10:00+02:00", status, ruecksendung: false, ...extra });
};
const noWindow = (z) => { delete z.zustellzeitfensterVon; delete z.zustellzeitfensterBis; };

const CASES = [
  // Ready for pickup: any of the three flags or the status text; overrides the ladder.
  {
    name: "Packstation (packageStationType), location and deadline from the text",
    status: "Ready for pickup",
    estimate: { from: null, to: "2026-10-06", text: "Packstation 142 · until Tue 6 Oct" },
    patch: (e, d, v, z) => {
      v.fortschritt = 4; noWindow(z); z.packageStationType = "PACKSTATION";
      lastEvent(v, "Die Sendung liegt in der Packstation 142 für den Empfänger bis zum 06.10.2026 zur Abholung bereit.");
    },
  },
  {
    name: "pickup code available, deadline without a year",
    status: "Ready for pickup",
    estimate: { from: null, to: "2026-10-05", text: "Packstation 17 · until Mon 5 Oct" },
    patch: (e, d, v, z) => {
      v.fortschritt = 5; noWindow(z); z.abholcodeAvailable = true;
      lastEvent(v, "Die Sendung wurde in die Packstation 17 eingeliefert. Abholung bis 05.10. möglich.");
    },
  },
  {
    name: "notified at a branch (benachrichtigtInFiliale), no location in the text",
    status: "Ready for pickup",
    estimate: { from: null, to: null, text: "Filiale" },
    patch: (e, d, v, z) => {
      noWindow(z); z.benachrichtigtInFiliale = true;
      lastEvent(v, "Der Empfänger wurde benachrichtigt.");
    },
  },
  {
    name: "status text 'abhol' alone",
    status: "Ready for pickup",
    estimate: { from: null, to: "2026-10-03", text: "Postfiliale · until Sat 3 Oct" },
    patch: (e, d, v, z) => {
      noWindow(z);
      lastEvent(v, "Die Sendung liegt ab sofort in der Postfiliale zur Abholung bereit. Abholfrist: bis 03.10.2026");
    },
  },
  // Problem: word list on the status or the last event, or `unplausibel`.
  {
    name: "failed delivery attempt ('nicht zugestellt')",
    status: "Problem",
    estimate: { from: null, to: null, text: "Delivery attempt failed" },
    patch: (e, d, v) => lastEvent(v, "Die Sendung konnte nicht zugestellt werden."),
  },
  {
    name: "address problem ('Adresse')",
    status: "Problem",
    estimate: { from: null, to: null, text: "Address problem" },
    patch: (e, d, v) => lastEvent(v, "Die Adresse des Empfängers ist unvollständig."),
  },
  {
    name: "damage ('beschädigt')",
    status: "Problem",
    estimate: { from: null, to: null, text: "Damaged" },
    patch: (e, d, v) => lastEvent(v, "Die Sendung wurde beschädigt und wird nachverpackt."),
  },
  {
    name: "unplausibel",
    status: "Problem",
    estimate: { from: null, to: null, text: "DHL reports inconsistent data" },
    patch: (e, d) => { d.unplausibel = true; },
  },
  // Returning / Returned: the return flags, before and after delivery.
  {
    name: "retoure, not delivered",
    status: "Returning",
    estimate: { from: "2026-10-01", to: "2026-10-01", text: "Thu 1 Oct" },
    patch: (e, d, v, z) => {
      d.retoure = true; z.zustellzeitfensterVon = "2026-10-01"; z.zustellzeitfensterBis = "2026-10-01";
      lastEvent(v, "Die Sendung wird an den Absender zurückgeschickt.");
    },
  },
  {
    name: "ruecksendung on the last event, not delivered",
    status: "Returning",
    estimate: null,
    patch: (e, d, v, z) => { noWindow(z); lastEvent(v, "Rücksendung eingeleitet.", { ruecksendung: true }); },
  },
  {
    name: "ruecksendung and delivered",
    status: "Returned",
    estimate: { from: "2026-09-29", to: "2026-09-29", text: "Returned Tue 29 Sep" },
    patch: (e, d, v, z) => {
      d.ruecksendung = true; d.istZugestellt = true; v.fortschritt = 5; noWindow(z);
      lastEvent(v, "Die Sendung wurde an den Absender zugestellt.");
    },
  },
  // Delivered: istZugestellt, or the top of the ladder.
  {
    name: "istZugestellt",
    status: "Delivered",
    estimate: { from: "2026-09-29", to: "2026-09-29", text: "Delivered Tue 29 Sep" },
    patch: (e, d, v, z) => { d.istZugestellt = true; noWindow(z); lastEvent(v, "Zustellung erfolgreich."); },
  },
  {
    name: "fortschritt == maximalFortschritt",
    status: "Delivered",
    estimate: { from: "2026-09-29", to: "2026-09-29", text: "Delivered Tue 29 Sep" },
    patch: (e, d, v, z) => { v.fortschritt = 5; noWindow(z); lastEvent(v, "Zustellung erfolgreich."); },
  },
  // The ladder, with the delivery window as the Estimate.
  { name: "fortschritt 0", status: "Announced", estimate: null, patch: (e, d, v, z) => { v.fortschritt = 0; noWindow(z); } },
  { name: "fortschritt 1", status: "Announced", estimate: null, patch: (e, d, v, z) => { v.fortschritt = 1; z.zustellzeitfensterVon = null; z.zustellzeitfensterBis = null; } },
  { name: "fortschritt 2", status: "In transit", estimate: { from: "2026-09-30", to: "2026-09-30", text: "Wed 30 Sep" }, patch: (e, d, v) => { v.fortschritt = 2; } },
  {
    name: "fortschritt 3, a two-day window",
    status: "In transit",
    estimate: { from: "2026-09-30", to: "2026-10-01", text: "Wed 30 Sep – Thu 1 Oct" },
    patch: (e, d, v, z) => { z.zustellzeitfensterBis = "2026-10-01"; },
  },
  {
    name: "fortschritt 4, a time window",
    status: "Out for delivery",
    estimate: { from: "2026-09-29T14:00:00+02:00", to: "2026-09-29T17:00:00+02:00", text: "Tue 29 Sep 14:00–17:00" },
    patch: (e, d, v, z) => { v.fortschritt = 4; z.zustellzeitfensterVon = "2026-09-29T14:00:00+02:00"; z.zustellzeitfensterBis = "2026-09-29T17:00:00+02:00"; },
  },
  // Unknown: no sendungsverlauf after the lookup.
  {
    name: "no sendungsverlauf",
    status: "Unknown",
    estimate: { from: null, to: null, text: "Not known to DHL yet" },
    patch: (e, d) => { delete d.sendungsverlauf; },
  },
];

for (const { name, status, estimate, patch } of CASES) {
  test(`DHL Status table: ${name} → ${status}`, async (t) => {
    const world = await makeWorld({ transport: fakeDhl({ [NUMBER]: response(patch) }) });
    t.after(() => world.cleanup());

    await world.run("add", NUMBER);
    assert.equal(await world.run("refresh"), 0);

    const s = await world.shipment(`dhl:${NUMBER}`);
    assert.equal(s.status, status);
    assert.deepEqual(s.estimate, estimate);
    assert.equal(s.delayed, false);
  });
}

test("the Problem text matches the last event even when the status line doesn't", async (t) => {
  const world = await makeWorld({
    transport: fakeDhl({
      [NUMBER]: response((e, d, v) => {
        v.events.push({ datum: "2026-09-29T09:10:00+02:00", status: "Zustellversuch: Sendung nicht zugestellt, Empfänger nicht angetroffen.", ruecksendung: false });
        v.status = "Die Sendung wird zugestellt.";
      }),
    }),
  });
  t.after(() => world.cleanup());

  await world.run("add", NUMBER);
  await world.run("refresh");

  const s = await world.shipment(`dhl:${NUMBER}`);
  assert.equal(s.status, "Problem");
  assert.equal(s.estimate.text, "Delivery attempt failed");
});
