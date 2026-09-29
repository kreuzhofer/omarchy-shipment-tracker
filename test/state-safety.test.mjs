// State dir safety: mode 700, read-modify-write under the flock (no lost
// writes), atomic files, and logs without tracking numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fakeDhl, fixture, makeWorld } from "./harness.mjs";

const FIRST = "00340434000000000033";
const SECOND = "00340434000000000044";

test("the state dir is created with mode 700", async (t) => {
  const world = await makeWorld();
  t.after(() => world.cleanup());

  await world.run("refresh");

  assert.equal(await world.stateDirMode(), 0o700);
});

test("an add during a running refresh is kept and looked up in the same run", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const world = await makeWorld({
    transport: fakeDhl({
      [FIRST]: async () => { await held; return { json: fixture("dhl/in-transit.json") }; },
      [SECOND]: { json: fixture("dhl/out-for-delivery.json") },
    }),
  });
  t.after(() => world.cleanup());
  await world.run("add", FIRST);

  const running = world.run("refresh");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await world.run("add", SECOND), 0);
  release();
  assert.equal(await running, 0);

  const statuses = Object.fromEntries((await world.shipmentsFile()).shipments.map((s) => [s.key, s.status]));
  assert.deepEqual(statuses, { [`dhl:${FIRST}`]: "In transit", [`dhl:${SECOND}`]: "Out for delivery" });
});

test("no temp files are left behind in the state dir", async (t) => {
  const world = await makeWorld({ transport: fakeDhl({ [FIRST]: { json: fixture("dhl/in-transit.json") } }) });
  t.after(() => world.cleanup());

  await world.run("add", FIRST);
  await world.run("refresh");

  assert.deepEqual((await readdir(world.stateDir)).sort(), ["shipments.json", "sources.json", "sources.json.lock"]);
});

test("logs and output carry counts only, never tracking numbers", async (t) => {
  const world = await makeWorld({
    transport: fakeDhl({ [FIRST]: { json: fixture("dhl/in-transit.json") }, [SECOND]: { network: true } }),
  });
  t.after(() => world.cleanup());

  await world.run("add", FIRST);
  await world.run("add", SECOND);
  await world.run("add", "302-0000000-0000000");
  await world.run("refresh");

  const printed = [...world.logs, ...world.output].join("\n");
  assert.ok(world.logs.length > 0);
  for (const secret of ["00340434", "302-0000000"]) assert.ok(!printed.includes(secret), `leaked in: ${printed}`);
});

test("sources.json marks a run as refreshing while it is active", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const world = await makeWorld({
    transport: fakeDhl({ [FIRST]: async () => { await held; return { json: fixture("dhl/in-transit.json") }; } }),
  });
  t.after(() => world.cleanup());
  await world.run("add", FIRST);

  const running = world.run("refresh");
  // The lookup is held, so the run stays active; wait for its first write
  // (a fixed 20 ms was too short on a busy machine).
  let refreshing = null;
  for (let i = 0; i < 200 && !refreshing; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    refreshing = await world.sourcesFile().then((f) => f.refreshing, () => null);
  }
  assert.deepEqual(refreshing, { startedAt: "2026-09-29T10:00:00.000Z" });
  release();
  assert.equal(await running, 0);

  assert.equal((await world.sourcesFile()).refreshing, null);
});
