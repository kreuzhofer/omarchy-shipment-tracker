// After a resume the catch-up run often starts before the network is up
// (#79). A full run that finds itself offline waits for the network with
// backoff and runs the Sources once more; a `--source` run fails fast. All
// tracking numbers are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDhl, fakeDhlAccount, fixture, makeWorld } from "./harness.mjs";

const NUMBER = "00340434000000000033";
const LATER = "00340434000000000034";
const OUT = { json: fixture("dhl/out-for-delivery.json") };

// The transport as it is right after a resume: the first `down` requests
// fail on the network, then everything answers.
function waking(routes, down) {
  const inner = fakeDhl({ online: { status: 200 }, ...routes });
  const transport = {
    calls: 0,
    async fetch(url, options) {
      transport.calls++;
      if (transport.calls <= down) throw Object.assign(new Error("fake network failure"), { code: "network" });
      return inner.fetch(url, options);
    },
  };
  return transport;
}

async function trackedWorld(t, transport) {
  const world = await makeWorld({ transport: fakeDhl({ [NUMBER]: { json: fixture("dhl/in-transit.json") } }) });
  t.after(() => world.cleanup());
  await world.run("add", NUMBER);
  assert.equal(await world.run("refresh"), 0);
  world.transport = transport;
  world.setClock("2026-09-29T13:00:00.000Z");
  return world;
}

test("an offline run waits for the network with backoff, then runs the Sources once more", async (t) => {
  // The lookup and the first two checks fail; the third check gets through.
  const world = await trackedWorld(t, waking({ [NUMBER]: OUT }, 3));

  assert.equal(await world.run("refresh"), 0);

  assert.deepEqual(world.sleeps, [5000, 10000, 20000]);
  assert.equal((await world.shipment(`dhl:${NUMBER}`)).status, "Out for delivery");
  const sources = await world.sourcesFile();
  assert.equal(sources.offline, false);
  assert.equal(sources.lastRun, "2026-09-29T13:00:35.000Z");
  assert.equal(sources.lastOnline, "2026-09-29T13:00:35.000Z");
  assert.equal(sources.refreshing, null);
  assert.equal((await world.shipmentsFile()).events.filter((e) => e.kind !== "connection").length, 1);
});

test("a network that stays down for about 2 minutes ends the run offline, as before", async (t) => {
  const world = await trackedWorld(t, waking({ [NUMBER]: OUT }, Infinity));
  const before = await world.shipment(`dhl:${NUMBER}`);

  assert.equal(await world.run("refresh"), 0);

  assert.deepEqual(world.sleeps, [5000, 10000, 20000, 40000, 45000]);
  // One lookup, then one check after each wait; the Sources are not run again.
  assert.equal(world.transport.calls, 1 + 5);
  assert.deepEqual(await world.shipment(`dhl:${NUMBER}`), before);
  const sources = await world.sourcesFile();
  assert.equal(sources.offline, true);
  assert.equal(sources.lastRun, "2026-09-29T13:00:00.000Z");
  assert.equal(sources.lastOnline, "2026-09-29T10:00:00.000Z");
  assert.equal(sources.refreshing, null);
});

test("a run that got through does not wait", async (t) => {
  const world = await trackedWorld(t, waking({ [NUMBER]: OUT }, 0));

  assert.equal(await world.run("refresh"), 0);

  assert.deepEqual(world.sleeps, []);
  assert.equal(world.transport.calls, 1);
});

test("a --source run fails fast", async (t) => {
  const dhl = fakeDhlAccount({ inbox: { json: fixture("dhl/account/inbox.json") }, enrich: { json: fixture("dhl/account/inbox.json") } });
  const world = await makeWorld({ transport: dhl });
  t.after(() => world.cleanup());
  assert.equal(await world.run("login", "dhl"), 0);
  dhl.token = () => ({ network: true });
  dhl.inbox = { network: true };
  world.setClock("2026-09-29T13:00:00.000Z");

  assert.equal(await world.run("refresh", "--source", "dhl"), 0);

  assert.deepEqual(world.sleeps, []);
  assert.equal((await world.sourcesFile()).offline, true);
});

test("no state lock is held while waiting: an add made meanwhile is kept and looked up by the retry", async (t) => {
  const routes = { [NUMBER]: { network: true }, [LATER]: { json: fixture("dhl/in-transit.json") } };
  const world = await trackedWorld(t, fakeDhl(routes));
  // The first check: the user adds a number while the run waits (the add
  // would time out if the run held the lock), and the network comes back.
  let checks = 0;
  routes.online = async () => {
    checks++;
    assert.equal(await world.run("add", LATER), 0);
    routes[NUMBER] = OUT;
    return { status: 200 };
  };

  assert.equal(await world.run("refresh"), 0);

  assert.equal(checks, 1);
  assert.deepEqual(world.sleeps, [5000]);
  assert.equal((await world.shipment(`dhl:${NUMBER}`)).status, "Out for delivery");
  assert.equal((await world.shipment(`dhl:${LATER}`)).status, "In transit");
  assert.equal((await world.sourcesFile()).offline, false);
});
