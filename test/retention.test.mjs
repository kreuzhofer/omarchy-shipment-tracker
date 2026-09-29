// Retention (spec #21, "Retention", from #20) at the refresh seam: the widget
// keeps at most 30 days of data, and a dropped Shipment never comes back as
// new. A test logs in to a fake DHL account (or Amazon account), moves the
// clock and looks only at shipments.json. All tracking numbers, Order IDs and
// titles here are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeChrome, fakeDhl, fakeDhlAccount, fixture, makeWorld } from "./harness.mjs";
import { historyPage, trackerPage } from "./fixtures/amazon/pages.mjs";

const A = "00340434000000000301";
const B = "00340434000000000302";
const MANUAL = "00340434000000000303";
const ORDER = "321-0000000-0000001";
const NUMBER = "00340434000000000304"; // the Order's DHL tracking number

const START = Date.parse("2026-09-01T10:00:00.000Z");
const day = (n) => new Date(START + n * 864e5).toISOString();

// A recorded DHL element (test/fixtures/dhl/<name>.json) under another number.
function element(name, id) {
  const recorded = fixture(`dhl/${name}.json`);
  return JSON.parse(JSON.stringify(recorded.sendungen[0]).replaceAll(recorded.sendungen[0].id, id));
}

// A fake DHL account whose Sendungsliste the test sets with show(...elements).
function account(anonymous = {}) {
  const dhl = fakeDhlAccount({ anonymous });
  dhl.show = (...elements) => {
    dhl.inbox = { json: { sendungen: elements, mergedAnonymousShipmentListIds: [], rateLimited: false } };
    dhl.enrich = dhl.inbox;
  };
  dhl.show();
  return dhl;
}

async function connected(t, ...first) {
  const dhl = account();
  dhl.show(...first);
  const world = await makeWorld({ now: day(0), transport: dhl });
  t.after(() => world.cleanup());
  assert.equal(await world.run("login", "dhl"), 0);
  return { world, dhl };
}

async function refreshOn(world, n) {
  world.setClock(day(n));
  assert.equal(await world.run("refresh"), 0);
  return world.shipmentsFile();
}

const keys = (file) => file.shipments.map((s) => s.key);

test("a Terminal Shipment is dropped 30 days after it turned Terminal, and DHL's archive never brings it back", async (t) => {
  const { world, dhl } = await connected(t, element("in-transit", A));
  dhl.show(element("delivered", A));
  await refreshOn(world, 2); // turns Delivered on day 2

  assert.deepEqual(keys(await refreshOn(world, 31)), [`dhl:${A}`], "29 days after Delivered it stays");

  const dropped = await refreshOn(world, 32);
  assert.deepEqual(keys(dropped), []);
  assert.deepEqual(dropped.dropped, [{ key: `dhl:${A}`, at: day(32) }]);
  assert.deepEqual(dropped.events, []);

  // The Sendungsliste keeps listing it for 80+ days.
  const later = await refreshOn(world, 40);
  assert.deepEqual(keys(later), []);
  assert.deepEqual(later.events, []);
  assert.deepEqual(later.dropped, [{ key: `dhl:${A}`, at: day(32) }]);
});

test("a stuck Shipment discovery still returns stays, however old its last change", async (t) => {
  const { world } = await connected(t, element("in-transit", A));

  const file = await refreshOn(world, 45);
  assert.deepEqual(keys(file), [`dhl:${A}`]);
  assert.deepEqual(file.dropped, []);
});

test("a Shipment discovery no longer returns is dropped 30 days after its last change", async (t) => {
  const { world, dhl } = await connected(t, element("in-transit", A), element("in-transit", B));
  dhl.show(element("in-transit", B), element("out-for-delivery", A));
  await refreshOn(world, 5); // A changes on day 5
  dhl.show(element("in-transit", B)); // then the Sendungsliste stops listing A

  assert.deepEqual(keys(await refreshOn(world, 34)), [`dhl:${A}`, `dhl:${B}`], "29 days after its last change it stays");

  const file = await refreshOn(world, 35);
  assert.deepEqual(keys(file), [`dhl:${B}`]);
  assert.deepEqual(file.dropped, [{ key: `dhl:${A}`, at: day(35) }]);
});

test("a failed run never drops a Shipment it couldn't see", async (t) => {
  const { world, dhl } = await connected(t, element("in-transit", A));
  dhl.inbox = { status: 500, text: "down" };

  const file = await refreshOn(world, 40);
  assert.deepEqual(keys(file), [`dhl:${A}`]);
  assert.deepEqual(file.dropped, []);
});

test("a manual add the Carrier never learned about is dropped 30 days after its last change", async (t) => {
  const world = await makeWorld({ now: day(0), transport: fakeDhl({ [MANUAL]: { json: fixture("dhl/unknown.json") } }) });
  t.after(() => world.cleanup());
  assert.equal(await world.run("add", MANUAL), 0);
  await refreshOn(world, 0);

  assert.deepEqual(keys(await refreshOn(world, 29)), [`dhl:${MANUAL}`]);
  const file = await refreshOn(world, 30);
  assert.deepEqual(keys(file), []);
  assert.deepEqual(file.dropped, [{ key: `dhl:${MANUAL}`, at: day(30) }]);
  assert.deepEqual(file.events, []);
});

test("adding a dropped number by hand tracks it again", async (t) => {
  const world = await makeWorld({ now: day(0), transport: fakeDhl({ [MANUAL]: { json: fixture("dhl/unknown.json") } }) });
  t.after(() => world.cleanup());
  assert.equal(await world.run("add", MANUAL), 0);
  await refreshOn(world, 0);
  await refreshOn(world, 30);

  assert.equal(await world.run("add", MANUAL), 0);
  const file = await world.shipmentsFile();
  assert.deepEqual(keys(file), [`dhl:${MANUAL}`]);
  assert.deepEqual(file.dropped, []);
});

test("dropped[] keeps only keys and drop dates, pruned after 120 days", async (t) => {
  const { world } = await connected(t, element("delivered", A));
  await refreshOn(world, 30);
  const file = await world.shipmentsFile();
  assert.deepEqual(file.dropped, [{ key: `dhl:${A}`, at: day(30) }]);

  assert.deepEqual((await refreshOn(world, 150)).dropped, [{ key: `dhl:${A}`, at: day(30) }], "120 days after the drop it is kept");
  assert.deepEqual((await refreshOn(world, 151)).dropped, []);
});

// ---- Amazon

const TITLE = "Gartenschlauch 20 m";
const history = () => historyPage([{ orderId: ORDER, shipments: [{ packageIndex: 0, shipmentId: "T0001", title: TITLE }] }]);
const tracker = (shortStatus, extra = {}) => trackerPage({
  orderId: ORDER, packageIndex: "0", shortStatus, trackingId: NUMBER, promise: { promiseMessage: "Lieferung morgen" }, ...extra,
}, { carrierLine: "Versendet mit DHL" });

async function amazonAccount(t, routes) {
  const world = await makeWorld({ now: day(0), chrome: fakeChrome(routes) });
  t.after(() => world.cleanup());
  assert.equal(await world.run("accounts", "add", "Personal", "--accept-risk"), 0);
  assert.equal(await world.run("login", "amazon:Personal"), 0);
  return world;
}

test("Amazon: a dropped Shipment isn't read again or brought back while the order history lists it", async (t) => {
  const routes = { history: history(), trackers: { [`${ORDER}#0`]: tracker("DELIVERED") } };
  const world = await amazonAccount(t, routes);
  const file = await refreshOn(world, 31);
  assert.deepEqual(keys(file), []);
  assert.deepEqual(file.dropped.map((d) => d.key).sort(), [`amazon:${ORDER}#0`, `dhl:${NUMBER}`]);

  // Were it still not Terminal on Amazon's side, it would be read first.
  routes.trackers[`${ORDER}#0`] = tracker("IN_TRANSIT");
  const reads = world.chrome.navigations.length;
  const later = await refreshOn(world, 32);
  assert.deepEqual(keys(later), []);
  assert.deepEqual(later.events, []);
  assert.deepEqual(world.chrome.navigations.slice(reads).map((n) => new URL(n.url).pathname), ["/gp/css/order-history"]);
});

test("Amazon: a Shipment dropped while its tracker page was being read doesn't come back", async (t) => {
  const routes = { history: history(), trackers: { [`${ORDER}#0`]: tracker("IN_TRANSIT") } };
  const world = await amazonAccount(t, routes);
  // A concurrent run drops the key after this one took its snapshot.
  const dropMeanwhile = () => {
    const file = JSON.parse(readFileSync(join(world.stateDir, "shipments.json"), "utf8"));
    file.dropped = [{ key: `amazon:${ORDER}#0`, at: day(0) }];
    writeFileSync(join(world.stateDir, "shipments.json"), JSON.stringify(file));
    return tracker("IN_TRANSIT");
  };
  routes.trackers[`${ORDER}#0`] = dropMeanwhile;
  const file = await world.shipmentsFile();
  file.shipments = [];
  await writeFile(join(world.stateDir, "shipments.json"), JSON.stringify(file));

  const after = await refreshOn(world, 1);
  assert.deepEqual(keys(after), []);
  assert.deepEqual(after.events, []);
});

test("A merged Amazon + DHL Shipment, once dropped, doesn't come back through the Sendungsliste", async (t) => {
  const dhl = account();
  dhl.show(element("delivered", NUMBER));
  const routes = { history: history(), trackers: { [`${ORDER}#0`]: tracker("DELIVERED") } };
  const world = await makeWorld({ now: day(0), chrome: fakeChrome(routes), transport: dhl });
  t.after(() => world.cleanup());
  assert.equal(await world.run("accounts", "add", "Personal", "--accept-risk"), 0);
  assert.equal(await world.run("login", "amazon:Personal"), 0);
  assert.equal(await world.run("login", "dhl"), 0);
  assert.deepEqual(keys(await world.shipmentsFile()), [`amazon:${ORDER}#0`]);

  const file = await refreshOn(world, 31);
  assert.deepEqual(keys(file), []);
  assert.deepEqual((await refreshOn(world, 33)).shipments, []);
});

// ---- Manual Amazon Order IDs (#26): ownership never brings a dropped Order back

const MANUAL_ORDER = "322-0000000-0000002";
const OTHER_ORDER = "323-0000000-0000003";
const listing = (...orderIds) => historyPage(orderIds.map((orderId) => ({
  orderId, shipments: [{ packageIndex: 0, shipmentId: "T0", title: "Drucker" }],
})));
const packageTracker = (orderId, shortStatus, extra = {}) => ({
  [`${orderId}#0`]: trackerPage({ orderId, packageIndex: "0", shortStatus, ...extra }),
});
const DELIVERED = {
  progressTracker: { lastTransitionPercentComplete: 100, lastReachedMilestone: "DELIVERED", numberOfReachedMilestones: 4 },
  promise: { promiseMessage: "Zugestellt: 1. September" },
};

async function businessAccount(t, routes) {
  const world = await makeWorld({ now: day(0), chrome: fakeChrome({ accounts: { Business: routes } }) });
  t.after(() => world.cleanup());
  assert.equal(await world.run("accounts", "add", "Business", "--accept-risk"), 0);
  assert.equal(await world.run("login", "amazon:Business"), 0);
  return world;
}

const trackerReads = (world, from) => world.chrome.navigations.slice(from)
  .map((n) => new URL(n.url)).filter((u) => u.pathname === "/progress-tracker/package").map((u) => u.searchParams.get("orderId"));

test("a manual Order's dropped package rows don't come back through the owning account", async (t) => {
  const routes = {
    history: listing(OTHER_ORDER),
    trackers: { ...packageTracker(OTHER_ORDER, "IN_TRANSIT"), ...packageTracker(MANUAL_ORDER, "DELIVERED", DELIVERED) },
    search: { [MANUAL_ORDER]: listing(MANUAL_ORDER) },
  };
  const world = await businessAccount(t, routes);
  assert.equal(await world.run("add", MANUAL_ORDER), 0);
  const owned = await refreshOn(world, 0);
  assert.deepEqual(owned.shipments.filter((s) => s.orderId === MANUAL_ORDER).map((s) => [s.key, s.status, s.connections]),
    [[`amazon:${MANUAL_ORDER}#0`, "Delivered", ["amazon:Business", "manual"]]]);

  const dropped = await refreshOn(world, 31);
  assert.equal(dropped.shipments.some((s) => s.orderId === MANUAL_ORDER), false);
  assert.deepEqual(dropped.dropped.map((d) => d.key), [`amazon:${MANUAL_ORDER}#0`]);

  // The account now lists the Order in its history, and it looks in transit.
  routes.history = listing(OTHER_ORDER, MANUAL_ORDER);
  Object.assign(routes.trackers, packageTracker(MANUAL_ORDER, "IN_TRANSIT"));
  const from = world.chrome.navigations.length;
  const later = await refreshOn(world, 32);
  assert.equal(later.shipments.some((s) => s.orderId === MANUAL_ORDER), false);
  assert.deepEqual(later.events, []);
  assert.deepEqual(trackerReads(world, from).filter((id) => id === MANUAL_ORDER), []);
});

test("a manual Order no account owned is dropped after 30 days, and its packages don't come back when an account lists it later", async (t) => {
  const routes = { history: listing(OTHER_ORDER), trackers: packageTracker(OTHER_ORDER, "IN_TRANSIT"), search: { [MANUAL_ORDER]: listing() } };
  const world = await businessAccount(t, routes);
  // The Login's paced page reads moved the clock a random 5–15 s on; the add
  // (its changedAt) happens at day 0 sharp, so day 30 is exactly 30 days later.
  world.setClock(day(0));
  assert.equal(await world.run("add", MANUAL_ORDER), 0);
  assert.equal((await refreshOn(world, 0)).shipments.find((s) => s.key === `amazon:${MANUAL_ORDER}`).linkOnly, true);

  const dropped = await refreshOn(world, 30);
  assert.equal(dropped.shipments.some((s) => s.orderId === MANUAL_ORDER), false);
  assert.deepEqual(dropped.dropped.map((d) => d.key), [`amazon:${MANUAL_ORDER}`]);

  routes.history = listing(OTHER_ORDER, MANUAL_ORDER);
  Object.assign(routes.trackers, packageTracker(MANUAL_ORDER, "IN_TRANSIT"));
  const from = world.chrome.navigations.length;
  const later = await refreshOn(world, 31);
  assert.equal(later.shipments.some((s) => s.orderId === MANUAL_ORDER), false);
  assert.deepEqual(later.events, []);
  assert.deepEqual(trackerReads(world, from).filter((id) => id === MANUAL_ORDER), []);

  // Adding it by hand again tracks it again.
  assert.equal(await world.run("add", MANUAL_ORDER), 0);
  const again = await world.shipmentsFile();
  assert.deepEqual(again.dropped, []);
  assert.deepEqual(again.shipments.filter((s) => s.orderId === MANUAL_ORDER).map((s) => s.key), [`amazon:${MANUAL_ORDER}`]);
});

// ---- Nothing raw is stored

const SHIPMENT_FIELDS = new Set([
  "key", "direction", "source", "account", "carrier", "connections", "title", "status", "estimate", "delayed",
  "trackingNumber", "orderId", "url", "changedAt", "terminalAt", "discoveredAt", "lastSeenAt",
  // bookkeeping of Delayed, merge and notifications
  "lastWindowTo", "detail", "notified", "probedBy", "linkOnly",
  // Dismissed (#35): the dismissal and what counts as a new tracking event
  "trackingEvent", "dismissedAt", "dismissedAs",
  // the item image (#58): its CDN URL and the cached file
  "imageUrl", "image",
]);

test("nothing raw is stored: only mapped fields, no responses or HTML", async (t) => {
  const dhl = account({ [NUMBER]: { json: { sendungen: [element("in-transit", NUMBER)] } } });
  dhl.show(element("in-transit", A), element("delivered", B));
  const routes = { history: history(), trackers: { [`${ORDER}#0`]: tracker("IN_TRANSIT") } };
  const world = await makeWorld({ now: day(0), chrome: fakeChrome(routes), transport: dhl });
  t.after(() => world.cleanup());
  assert.equal(await world.run("login", "dhl"), 0);
  assert.equal(await world.run("accounts", "add", "Personal", "--accept-risk"), 0);
  assert.equal(await world.run("login", "amazon:Personal"), 0);
  const file = await refreshOn(world, 1);
  assert.equal(file.shipments.length, 3);
  for (const s of file.shipments) {
    assert.deepEqual(Object.keys(s).filter((k) => !SHIPMENT_FIELDS.has(k)), [], s.key);
  }
  const text = JSON.stringify(file);
  for (const raw of ["<html", "sendungsverlauf", "sendungsdetails", "page-state", "promiseMessage"]) {
    assert.equal(text.includes(raw), false, raw);
  }
  assert.deepEqual((await readdir(world.stateDir)).sort(), ["dhl-tokens.json", "dhl-tokens.json.lock", "shipments.json", "sources.json", "sources.json.lock"]);
});
