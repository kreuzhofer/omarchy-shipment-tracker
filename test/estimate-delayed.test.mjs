// Estimate and Delayed across runs. Delayed is set when a new Estimate ends
// later than the last one seen, and cleared when the Shipment turns Terminal.
// All tracking numbers here are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeChrome, fakeDhl, fixture, makeWorld } from "./harness.mjs";
import { historyPage, trackerPage } from "./fixtures/amazon/pages.mjs";

const NUMBER = "00340434000000000033";

function inTransit(from, to) {
  const json = fixture("dhl/in-transit.json");
  const z = json.sendungen[0].sendungsdetails.zustellung;
  z.zustellzeitfensterVon = from;
  z.zustellzeitfensterBis = to;
  return { json };
}

async function world(t, first) {
  const responses = { [NUMBER]: first };
  const w = await makeWorld({ transport: fakeDhl(responses) });
  t.after(() => w.cleanup());
  await w.run("add", NUMBER);
  await w.run("refresh");
  return { w, responses };
}

test("an Estimate that moves later marks the Shipment Delayed", async (t) => {
  const { w, responses } = await world(t, inTransit("2026-09-30", "2026-09-30"));
  assert.equal((await w.shipment(`dhl:${NUMBER}`)).delayed, false);

  responses[NUMBER] = inTransit("2026-10-01", "2026-10-02");
  w.setClock("2026-09-29T11:00:00.000Z");
  await w.run("refresh");

  const s = await w.shipment(`dhl:${NUMBER}`);
  assert.equal(s.delayed, true);
  assert.deepEqual(s.estimate, { from: "2026-10-01", to: "2026-10-02", text: "Thu 1 Oct – Fri 2 Oct" });
  assert.equal(s.changedAt, "2026-09-29T11:00:00.000Z");
});

test("an Estimate that moves earlier or stays is not Delayed", async (t) => {
  const { w, responses } = await world(t, inTransit("2026-09-30", "2026-10-01"));

  responses[NUMBER] = inTransit("2026-09-30", "2026-09-30");
  w.setClock("2026-09-29T11:00:00.000Z");
  await w.run("refresh");
  w.setClock("2026-09-29T12:00:00.000Z");
  await w.run("refresh");

  const s = await w.shipment(`dhl:${NUMBER}`);
  assert.equal(s.delayed, false);
  assert.equal(s.estimate.text, "Wed 30 Sep");
  assert.equal(s.changedAt, "2026-09-29T11:00:00.000Z");
});

test("Delayed stays while in flight, even when the window is gone for a run", async (t) => {
  const { w, responses } = await world(t, inTransit("2026-09-30", "2026-09-30"));

  responses[NUMBER] = inTransit("2026-10-02", "2026-10-02");
  w.setClock("2026-09-29T11:00:00.000Z");
  await w.run("refresh");
  responses[NUMBER] = inTransit(null, null);
  w.setClock("2026-09-29T12:00:00.000Z");
  await w.run("refresh");
  responses[NUMBER] = inTransit("2026-10-02", "2026-10-02");
  w.setClock("2026-09-29T13:00:00.000Z");
  await w.run("refresh");

  const s = await w.shipment(`dhl:${NUMBER}`);
  assert.equal(s.delayed, true);
  assert.equal(s.estimate.text, "Fri 2 Oct");
});

test("a window that is gone for a run and comes back later still counts as Delayed", async (t) => {
  const { w, responses } = await world(t, inTransit("2026-09-30", "2026-09-30"));

  responses[NUMBER] = inTransit(null, null);
  w.setClock("2026-09-29T11:00:00.000Z");
  await w.run("refresh");
  assert.equal((await w.shipment(`dhl:${NUMBER}`)).delayed, false);

  responses[NUMBER] = inTransit("2026-10-01", "2026-10-01");
  w.setClock("2026-09-29T12:00:00.000Z");
  await w.run("refresh");

  assert.equal((await w.shipment(`dhl:${NUMBER}`)).delayed, true);
});

test("turning Terminal clears Delayed and shows the delivery date; it is never re-fetched", async (t) => {
  const { w, responses } = await world(t, inTransit("2026-09-28", "2026-09-28"));
  responses[NUMBER] = inTransit("2026-09-29", "2026-09-29");
  w.setClock("2026-09-29T08:00:00.000Z");
  await w.run("refresh");
  assert.equal((await w.shipment(`dhl:${NUMBER}`)).delayed, true);

  responses[NUMBER] = { json: fixture("dhl/delivered.json") };
  responses[NUMBER].json.sendungen[0].id = NUMBER;
  w.setClock("2026-09-29T12:00:00.000Z");
  await w.run("refresh");
  delete responses[NUMBER];
  w.setClock("2026-09-29T13:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);

  const s = await w.shipment(`dhl:${NUMBER}`);
  assert.equal(s.status, "Delivered");
  assert.equal(s.delayed, false);
  assert.deepEqual(s.estimate, { from: "2026-09-29", to: "2026-09-29", text: "Delivered Tue 29 Sep" });
  assert.equal(s.terminalAt, "2026-09-29T12:00:00.000Z");
  assert.equal(s.lastSeenAt, "2026-09-29T12:00:00.000Z");
});

// ---- An Amazon promise in relative words (#92): "Morgen erwartet" read day
// after day is an Estimate that moves one day later each time.

const ORDER = "305-5555555-5555555";
const AMAZON_KEY = `amazon:${ORDER}#0`;

// An untracked parcel as seen live: an exception state (Problem), no
// milestones, Amazon's own promise.
const untracked = (promiseMessage) => trackerPage({
  orderId: ORDER, packageIndex: "0", shortStatus: "UNTRACKABLE", trackingId: null,
  exceptionStateIdentifier: "UNTRACKABLE_PRE_PROMISED_DELIVERY_DATE", progressTracker: undefined,
  promise: { promiseMessage },
});

async function amazonWorld(t, first) {
  const trackers = { [`${ORDER}#0`]: first };
  const history = historyPage([{ orderId: ORDER, shipments: [{ packageIndex: 0, shipmentId: "Teeeeeeee", title: "Ein Ersatzteil" }] }]);
  const w = await makeWorld({ chrome: fakeChrome({ history, trackers }), transport: fakeDhl({}) });
  t.after(() => w.cleanup());
  assert.equal(await w.run("accounts", "add", "Business", "--accept-risk"), 0);
  assert.equal(await w.run("login", "amazon:Business"), 0);
  return { w, trackers };
}

// One refresh at `iso`; what the Shipment shows and the run's notifications.
async function day(w, iso) {
  w.setClock(iso);
  assert.equal(await w.run("refresh"), 0);
  const s = await w.shipment(AMAZON_KEY);
  const events = (await w.shipmentsFile()).events.map((e) => e.kind);
  return { to: s.estimate.to, lastWindowTo: s.lastWindowTo, delayed: s.delayed, events };
}

test("'Morgen erwartet' read day after day turns Delayed on the first later day and notifies once", async (t) => {
  // The Login's first sync on Tue 29 Sep: tomorrow is Wed 30 Sep.
  const { w } = await amazonWorld(t, untracked("Morgen erwartet"));
  const first = await w.shipment(AMAZON_KEY);
  assert.deepEqual([first.status, first.estimate.to, first.delayed], ["Problem", "2026-09-30", false]);

  const seen = [];
  // A later run the same day sees the same "tomorrow": no change.
  seen.push(await day(w, "2026-09-29T16:00:00.000Z"));
  for (const date of ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]) seen.push(await day(w, `${date}T07:00:00.000Z`));

  assert.deepEqual(seen, [
    { to: "2026-09-30", lastWindowTo: "2026-09-30", delayed: false, events: [] },
    { to: "2026-10-01", lastWindowTo: "2026-10-01", delayed: true, events: ["delayed"] },
    { to: "2026-10-02", lastWindowTo: "2026-10-02", delayed: true, events: [] },
    { to: "2026-10-03", lastWindowTo: "2026-10-03", delayed: true, events: [] },
    { to: "2026-10-04", lastWindowTo: "2026-10-04", delayed: true, events: [] },
  ]);
});

test("'Heute' read on the promised day is not later; 'Heute' the day after is", async (t) => {
  const { w, trackers } = await amazonWorld(t, untracked("Morgen erwartet"));
  trackers[`${ORDER}#0`] = untracked("Heute erwartet");
  // Tomorrow came: "today" is the same day as the promise.
  assert.deepEqual(await day(w, "2026-09-30T07:00:00.000Z"), { to: "2026-09-30", lastWindowTo: "2026-09-30", delayed: false, events: [] });
  // Still "today" a day later: it moved.
  assert.deepEqual(await day(w, "2026-10-01T07:00:00.000Z"), { to: "2026-10-01", lastWindowTo: "2026-10-01", delayed: true, events: ["delayed"] });
});
