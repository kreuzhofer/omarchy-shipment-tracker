// `remove <shipmentKey>` takes back a manual add. All tracking numbers here are
// synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeWorld } from "./harness.mjs";

const MANUAL = "00340434000000000011";
const OTHER = "00340434000000000022";

test("removing a manual add deletes the Shipment and leaves the others", async (t) => {
  const world = await makeWorld();
  t.after(() => world.cleanup());
  await world.run("add", MANUAL);
  await world.run("add", OTHER);

  assert.equal(await world.run("remove", `dhl:${MANUAL}`), 0);

  const file = await world.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => s.key), [`dhl:${OTHER}`]);
  assert.deepEqual(file.dropped, []);
  assert.deepEqual(file.events, []);
  assert.deepEqual(world.output, ["Added 1 Shipment", "Added 1 Shipment", "Removed 1 Shipment"]);
});

test("a removed number can be added again", async (t) => {
  const world = await makeWorld();
  t.after(() => world.cleanup());
  await world.run("add", MANUAL);
  await world.run("remove", `dhl:${MANUAL}`);
  world.setClock("2026-09-29T11:00:00.000Z");

  assert.equal(await world.run("add", MANUAL), 0);

  const s = await world.shipment(`dhl:${MANUAL}`);
  assert.equal(s.discoveredAt, "2026-09-29T11:00:00.000Z");
});

test("a Shipment a Connection also knows only loses its manual mark", async (t) => {
  const world = await makeWorld();
  t.after(() => world.cleanup());
  await world.run("add", MANUAL);
  const file = await world.shipmentsFile();
  file.shipments[0].connections = ["dhl", "manual"];
  await writeFile(join(world.stateDir, "shipments.json"), JSON.stringify(file));

  assert.equal(await world.run("remove", `dhl:${MANUAL}`), 0);

  const s = await world.shipment(`dhl:${MANUAL}`);
  assert.deepEqual(s.connections, ["dhl"]);
});

test("remove refuses Shipments that weren't added by hand and unknown keys", async (t) => {
  const world = await makeWorld();
  t.after(() => world.cleanup());
  await mkdir(world.stateDir, { recursive: true });
  await writeFile(join(world.stateDir, "shipments.json"), JSON.stringify({
    shipments: [{ key: `dhl:${OTHER}`, connections: ["dhl"], status: "In transit" }],
    dropped: [], lastEventId: 0, events: [],
  }));

  assert.equal(await world.run("remove", `dhl:${OTHER}`), 2);
  assert.equal(await world.run("remove", `dhl:${MANUAL}`), 2);
  assert.equal(await world.run("remove"), 2);

  const file = await world.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => [s.key, s.connections]), [[`dhl:${OTHER}`, ["dhl"]]]);
});
