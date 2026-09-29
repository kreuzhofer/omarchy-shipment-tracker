// Estimate and Delayed across runs. Delayed is set when a new Estimate ends
// later than the last one seen, and cleared when the Shipment turns Terminal.
// All tracking numbers here are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDhl, fixture, makeWorld } from "./harness.mjs";

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
