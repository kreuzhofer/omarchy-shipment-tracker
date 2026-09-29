// The DHL ladder at the refresh seam: each recorded (synthetic) response and
// the Status and Estimate it must produce. The rest of the Status table is in
// dhl-status-table.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDhl, fixture, makeWorld } from "./harness.mjs";

const LADDER = [
  { number: "00340434000000000022", file: "dhl/announced.json", status: "Announced", estimate: null },
  { number: "00340434000000000033", file: "dhl/in-transit.json", status: "In transit", estimate: { from: "2026-09-30", to: "2026-09-30", text: "Wed 30 Sep" } },
  { number: "00340434000000000044", file: "dhl/out-for-delivery.json", status: "Out for delivery", estimate: { from: "2026-09-29", to: "2026-09-29", text: "Tue 29 Sep" } },
  { number: "00340434000000000055", file: "dhl/delivered.json", status: "Delivered", estimate: { from: "2026-09-29", to: "2026-09-29", text: "Delivered Tue 29 Sep" } },
];

for (const { number, file, status, estimate } of LADDER) {
  test(`DHL ladder: ${file} → ${status}`, async (t) => {
    const world = await makeWorld({ transport: fakeDhl({ [number]: { json: fixture(file) } }) });
    t.after(() => world.cleanup());

    await world.run("add", number);
    world.setClock("2026-09-29T10:05:00.000Z");
    assert.equal(await world.run("refresh"), 0);

    const s = await world.shipment(`dhl:${number}`);
    assert.equal(s.status, status);
    assert.equal(s.direction, "Incoming");
    assert.deepEqual(s.estimate, estimate);
    assert.equal(s.changedAt, "2026-09-29T10:05:00.000Z");
    assert.equal(s.lastSeenAt, "2026-09-29T10:05:00.000Z");
    assert.deepEqual((await world.shipmentsFile()).events, []);
  });
}

test("a Status moves along the ladder across runs; an unchanged run keeps changedAt", async (t) => {
  const number = "00340434000000000033";
  const responses = { [number]: { json: fixture("dhl/unknown.json") } };
  responses[number].json.sendungen[0].id = number;
  const world = await makeWorld({ transport: fakeDhl(responses) });
  t.after(() => world.cleanup());

  await world.run("add", number);
  await world.run("refresh");
  assert.equal((await world.shipment(`dhl:${number}`)).status, "Unknown");

  responses[number] = { json: fixture("dhl/in-transit.json") };
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");
  world.setClock("2026-09-29T12:00:00.000Z");
  await world.run("refresh");

  const s = await world.shipment(`dhl:${number}`);
  assert.equal(s.status, "In transit");
  assert.equal(s.changedAt, "2026-09-29T11:00:00.000Z");
  assert.equal(s.lastSeenAt, "2026-09-29T12:00:00.000Z");
});

test("a Delivered Shipment is Terminal and never re-fetched", async (t) => {
  const number = "00340434000000000055";
  const responses = { [number]: { json: fixture("dhl/delivered.json") } };
  const world = await makeWorld({ transport: fakeDhl(responses) });
  t.after(() => world.cleanup());

  await world.run("add", number);
  await world.run("refresh");
  // A later request would fail loudly: the fake has no response any more.
  delete responses[number];
  world.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);

  const s = await world.shipment(`dhl:${number}`);
  assert.equal(s.status, "Delivered");
  assert.equal(s.terminalAt, "2026-09-29T10:00:00.000Z");
  assert.equal(s.lastSeenAt, "2026-09-29T10:00:00.000Z");
  assert.equal((await world.sourcesFile()).lastRun, "2026-09-29T11:00:00.000Z");
});
