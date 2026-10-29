// An Amazon parcel without carrier tracking (#91): its tracker page's
// page-state names the placeholder `<orderId>-InvalidId` as the tracking ID.
// That is no tracking number: never stored, matched, looked up or searched
// for. All Order IDs and items are synthetic; see fixtures/amazon/pages.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeChrome, fakeDhl, makeWorld } from "./harness.mjs";
import { historyPage, trackerPage } from "./fixtures/amazon/pages.mjs";

const ORDER = "305-5555555-5555555";
const KEY = `amazon:${ORDER}#0`;
const PLACEHOLDER = `${ORDER}-InvalidId`;

const HISTORY = historyPage([{ orderId: ORDER, shipments: [{ packageIndex: 0, shipmentId: "Teeeeeeee", title: "Ein Ersatzteil" }] }]);

// As seen live for a seller shipping untracked: no milestones, an exception
// state, Amazon's own promise.
const untrackable = (state = {}, options) => trackerPage({
  orderId: ORDER, packageIndex: "0", shortStatus: "UNTRACKABLE", trackingId: PLACEHOLDER,
  exceptionStateIdentifier: "UNTRACKABLE_PRE_PROMISED_DELIVERY_DATE", progressTracker: undefined,
  promise: { promiseMessage: "Morgen erwartet" },
  ...state,
}, options);

async function amazonWorld(t, trackers) {
  // Any lookup fails the run's count: fakeDhl knows no number.
  const world = await makeWorld({ chrome: fakeChrome({ history: HISTORY, trackers }), transport: fakeDhl({}) });
  t.after(() => world.cleanup());
  assert.equal(await world.run("accounts", "add", "Business", "--accept-risk"), 0);
  return world;
}

test("an untrackable parcel's '<orderId>-InvalidId' is no tracking number: not stored, not looked up; still a Problem", async (t) => {
  // Even when the page names a Carrier that is looked up by number.
  const world = await amazonWorld(t, { [`${ORDER}#0`]: untrackable({}, { carrierLine: "Versendet mit DHL" }) });
  assert.equal(await world.run("login", "amazon:Business"), 0);
  world.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);

  const s = await world.shipment(KEY);
  assert.equal(s.status, "Problem");
  assert.equal(s.trackingNumber, undefined);
  assert.equal(JSON.stringify(await world.shipmentsFile()).includes("InvalidId"), false);
  assert.deepEqual((await world.shipmentsFile()).shipments.map((x) => x.key), [KEY]);
  assert.ok(world.logs.every((l) => !/looked up \d+ \(\d+ unknown\), [1-9]/.test(l)), world.logs.join("\n"));
});

test("a placeholder stored before is cleaned on the next read", async (t) => {
  const world = await amazonWorld(t, { [`${ORDER}#0`]: untrackable() });
  assert.equal(await world.run("login", "amazon:Business"), 0);
  // As an earlier version stored it.
  const file = await world.shipmentsFile();
  Object.assign(file.shipments.find((x) => x.key === KEY), { trackingNumber: PLACEHOLDER, carrier: "DHL" });
  writeFileSync(join(world.stateDir, "shipments.json"), JSON.stringify(file));

  world.setClock("2026-09-30T08:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);

  const s = await world.shipment(KEY);
  assert.equal(s.trackingNumber, undefined);
  assert.equal(s.status, "Problem");
  assert.equal(JSON.stringify(await world.shipmentsFile()).includes("InvalidId"), false);
  assert.ok(world.logs.every((l) => !/looked up \d+ \(\d+ unknown\), [1-9]/.test(l)), world.logs.join("\n"));
});

test("a real tracking number on the same page is still stored", async (t) => {
  const world = await amazonWorld(t, { [`${ORDER}#0`]: untrackable({ trackingId: "DE0000000077" }) });
  assert.equal(await world.run("login", "amazon:Business"), 0);
  assert.equal((await world.shipment(KEY)).trackingNumber, "DE0000000077");
});
