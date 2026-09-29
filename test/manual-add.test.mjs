// Manual add of a DHL tracking number, looked up anonymously by `refresh`.
// All tracking numbers here are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDhl, fixture, makeWorld } from "./harness.mjs";

const UNKNOWN = "00340434000000000011";
const DHL_PAGE = "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=";

test("a number DHL doesn't know shows as Unknown, Incoming, 'Not known to DHL yet'", async (t) => {
  const world = await makeWorld({ transport: fakeDhl({ [UNKNOWN]: { json: fixture("dhl/unknown.json") } }) });
  t.after(() => world.cleanup());

  assert.equal(await world.run("add", UNKNOWN), 0);
  world.setClock("2026-09-29T10:05:00.000Z");
  assert.equal(await world.run("refresh"), 0);

  const file = await world.shipmentsFile();
  assert.deepEqual(file.shipments, [{
    key: `dhl:${UNKNOWN}`,
    direction: "Incoming",
    source: "DHL",
    account: null,
    carrier: "DHL",
    connections: ["manual"],
    title: UNKNOWN,
    status: "Unknown",
    estimate: { from: null, to: null, text: "Not known to DHL yet" },
    delayed: false,
    trackingNumber: UNKNOWN,
    url: DHL_PAGE + UNKNOWN,
    changedAt: "2026-09-29T10:05:00.000Z",
    discoveredAt: "2026-09-29T10:00:00.000Z",
    lastSeenAt: "2026-09-29T10:05:00.000Z",
    notified: { status: "Unknown", delayed: false },
  }]);
  assert.deepEqual(file.events, []);
  assert.equal(file.lastEventId, 0);
  assert.deepEqual(await world.sourcesFile(), {
    lastRun: "2026-09-29T10:05:00.000Z",
    lastOnline: "2026-09-29T10:05:00.000Z",
    refreshing: null,
    offline: false,
    connections: {},
  });
});

test("before the first refresh a manual add reads Unknown · 'Looking up…'", async (t) => {
  const world = await makeWorld();
  t.after(() => world.cleanup());

  assert.equal(await world.run("add", ` ${UNKNOWN.slice(0, 10)} ${UNKNOWN.slice(10)} `), 0);

  const s = await world.shipment(`dhl:${UNKNOWN}`);
  assert.equal(s.status, "Unknown");
  assert.deepEqual(s.estimate, { from: null, to: null, text: "Looking up…" });
  assert.equal(s.lastSeenAt, null);
});

test("adding the same number twice keeps one Shipment", async (t) => {
  const world = await makeWorld();
  t.after(() => world.cleanup());

  await world.run("add", UNKNOWN);
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("add", UNKNOWN.toLowerCase());

  const file = await world.shipmentsFile();
  assert.equal(file.shipments.length, 1);
  assert.equal(file.shipments[0].discoveredAt, "2026-09-29T10:00:00.000Z");
});

test("add rejects input that isn't a tracking number or an Amazon Order ID", async (t) => {
  const world = await makeWorld();
  t.after(() => world.cleanup());

  assert.equal(await world.run("add", "not a number!"), 2);
  assert.equal(await world.run("add"), 2);

  assert.deepEqual((await world.shipmentsFile().catch(() => ({ shipments: [] }))).shipments, []);
});
