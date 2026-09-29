// A failed lookup never changes or deletes a Shipment; being offline only
// marks the run offline. All tracking numbers here are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDhl, fixture, makeWorld } from "./harness.mjs";

const NUMBER = "00340434000000000033";

const FAILURES = [
  { name: "no connection", response: { network: true }, offline: true },
  { name: "HTTP 503", response: { status: 503, text: "Service Unavailable" }, offline: false },
  { name: "a changed data format (HTML instead of JSON)", response: { text: "<html>Wartungsarbeiten</html>" }, offline: false },
  { name: "a changed data format (no sendungen)", response: { json: { shipments: [] } }, offline: false },
  { name: "rate limiting", response: { json: { sendungen: [], rateLimited: true } }, offline: false },
];

for (const { name, response, offline } of FAILURES) {
  test(`${name} leaves the Shipment as it was`, async (t) => {
    const responses = { [NUMBER]: { json: fixture("dhl/in-transit.json") } };
    const world = await makeWorld({ transport: fakeDhl(responses) });
    t.after(() => world.cleanup());
    await world.run("add", NUMBER);
    await world.run("refresh");
    const before = await world.shipment(`dhl:${NUMBER}`);

    responses[NUMBER] = response;
    world.setClock("2026-09-29T11:00:00.000Z");
    assert.equal(await world.run("refresh"), 0);

    assert.deepEqual(await world.shipment(`dhl:${NUMBER}`), before);
    const sources = await world.sourcesFile();
    assert.equal(sources.lastRun, "2026-09-29T11:00:00.000Z");
    assert.equal(sources.offline, offline);
    assert.deepEqual(sources.connections, {});
  });
}

test("a manual add that was never reached stays 'Looking up…' while offline", async (t) => {
  const world = await makeWorld({ transport: fakeDhl({ [NUMBER]: { network: true } }) });
  t.after(() => world.cleanup());

  await world.run("add", NUMBER);
  await world.run("refresh");

  const s = await world.shipment(`dhl:${NUMBER}`);
  assert.equal(s.status, "Unknown");
  assert.equal(s.estimate.text, "Looking up…");
  assert.equal((await world.sourcesFile()).offline, true);
});

test("a refresh with nothing to look up still records the run", async (t) => {
  const world = await makeWorld();
  t.after(() => world.cleanup());

  assert.equal(await world.run("refresh"), 0);

  assert.deepEqual(await world.shipmentsFile(), { shipments: [], dropped: [], lastEventId: 0, events: [] });
  assert.deepEqual(await world.sourcesFile(), {
    lastRun: "2026-09-29T10:00:00.000Z", refreshing: null, offline: false, connections: {},
  });
});
