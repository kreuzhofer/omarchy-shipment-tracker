// Removing an Amazon account and disconnecting DHL (#32; spec #21, "Removing
// and disconnecting"). Removal deletes the Connection's profile or token and
// drops the Shipments known only through it. Merged Shipments keep their
// other side, manual adds stay. All Order IDs, tracking numbers, titles and
// tokens here are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeBrowser, fakeChrome, fakeDhl, fakeDhlAccount, fixture, makeWorld } from "./harness.mjs";
import { historyPage, trackerPage } from "./fixtures/amazon/pages.mjs";

const ORDER = "321-0000000-0000001";
const NUMBER = "00340434000000000321"; // carried by DHL, in the Sendungsliste
const DHL_ONLY = "00340434000000000322"; // only in the Sendungsliste
const MANUAL_DHL = "00340434000000000323"; // added by hand, also in the Sendungsliste
const OTHER_ORDER = "322-0000000-0000002"; // Amazon only, Amazon Logistics
const MANUAL_ORDER = "323-0000000-0000003"; // added by hand, owned by the account
const ORDER_PAGE = "https://www.amazon.de/your-orders/order-details?orderID=";
const TRACKING_PAGE = "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=";

function dhlElement(name, id) {
  const recorded = fixture(`dhl/${name}.json`);
  return JSON.parse(JSON.stringify(recorded.sendungen[0]).replaceAll(recorded.sendungen[0].id, id));
}
const answer = (...elements) => ({ json: { sendungen: elements } });

// A DHL account whose Sendungsliste lists `elements`; `anonymous` answers the
// lookup without a login.
function dhlAccount(elements, anonymous = {}) {
  const account = fakeDhlAccount({ inbox: answer(...elements), enrich: () => answer(...elements), anonymous });
  return account;
}

const TITLES = { [ORDER]: "Gartenschlauch 20 m", [OTHER_ORDER]: "Kaffeebohnen 1 kg", [MANUAL_ORDER]: "Blumenerde 40 l" };
const historyWith = (...orders) => historyPage(orders.map((orderId) => ({
  orderId,
  shipments: [{ packageIndex: 0, shipmentId: `T${orderId.slice(-4)}`, title: TITLES[orderId] }],
})));
const TRACKERS = {
  [`${ORDER}#0`]: trackerPage({ orderId: ORDER, packageIndex: "0", shortStatus: "IN_TRANSIT", isMfn: true, trackingId: NUMBER }, { carrierLine: "Versendet mit DHL" }),
  [`${OTHER_ORDER}#0`]: trackerPage({ orderId: OTHER_ORDER, packageIndex: "0", shortStatus: "IN_TRANSIT", trackingId: "DE0000000322" }, { carrierLine: "Versand durch Amazon" }),
  [`${MANUAL_ORDER}#0`]: trackerPage({ orderId: MANUAL_ORDER, packageIndex: "0", shortStatus: "IN_TRANSIT", trackingId: "DE0000000323" }, { carrierLine: "Versand durch Amazon" }),
};

async function world(t, { transport = fakeDhl({}), history = historyWith(ORDER, OTHER_ORDER), search = {}, browser } = {}) {
  const w = await makeWorld({ transport, browser, chrome: fakeChrome({ history, trackers: TRACKERS, search }) });
  t.after(() => w.cleanup());
  return w;
}

async function connectAmazon(w, label = "Personal") {
  assert.equal(await w.run("accounts", "add", label, "--accept-risk"), 0);
  assert.equal(await w.run("login", `amazon:${label}`), 0);
}

const keys = async (w) => (await w.shipmentsFile()).shipments.map((s) => s.key).sort();
const kinds = (events) => events.map((e) => [e.kind, e.key ?? null, e.status ?? null]);

// ---- Disconnecting DHL

test("disconnect dhl deletes the token, its lock and the login profile, and puts Health back to not-set-up", async (t) => {
  const w = await world(t, { transport: dhlAccount([dhlElement("in-transit", DHL_ONLY)]) });
  assert.equal(await w.run("login", "dhl"), 0);
  // What `login dhl` leaves behind: the Chrome login profile and the token.
  await mkdir(join(w.dataDir, "dhl", "Default"), { recursive: true });
  await writeFile(join(w.dataDir, "dhl", "Default", "Cookies"), "synthetic");
  assert.equal(await w.exists(join(w.stateDir, "dhl-tokens.json")), true);

  w.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await w.run("disconnect", "dhl"), 0);

  assert.equal(w.output.at(-1), "Disconnected DHL");
  assert.equal(await w.exists(join(w.stateDir, "dhl-tokens.json")), false);
  assert.equal(await w.exists(join(w.stateDir, "dhl-tokens.json.lock")), false);
  assert.equal(await w.exists(join(w.dataDir, "dhl")), false);
  const dhl = (await w.sourcesFile()).connections.dhl;
  assert.equal(dhl.health, "not-set-up");
  assert.equal(dhl.lastOk, null);
  assert.equal(dhl.since, "2026-09-29T11:00:00.000Z");
});

test("disconnecting DHL drops the Shipments only DHL knew and keeps manual adds", async (t) => {
  const anonymous = { [MANUAL_DHL]: answer(dhlElement("out-for-delivery", MANUAL_DHL)) };
  const transport = dhlAccount([dhlElement("in-transit", DHL_ONLY), dhlElement("in-transit", MANUAL_DHL)], anonymous);
  const w = await world(t, { transport });
  assert.equal(await w.run("add", MANUAL_DHL), 0);
  assert.equal(await w.run("login", "dhl"), 0);
  assert.deepEqual(await keys(w), [`dhl:${DHL_ONLY}`, `dhl:${MANUAL_DHL}`]);

  assert.equal(await w.run("disconnect", "dhl"), 0);

  const file = await w.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => s.key), [`dhl:${MANUAL_DHL}`]);
  assert.deepEqual(file.shipments[0].connections, ["manual"]);

  // The manual add goes on through the anonymous lookup.
  w.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);
  assert.equal((await w.shipment(`dhl:${MANUAL_DHL}`)).status, "Out for delivery");
  assert.equal((await w.sourcesFile()).connections.dhl.health, "not-set-up");
});

test("disconnecting DHL leaves a merged Shipment to Amazon, which keeps DHL detail through the anonymous lookup", async (t) => {
  const anonymous = { [NUMBER]: answer(dhlElement("out-for-delivery", NUMBER)) };
  const w = await world(t, { transport: dhlAccount([dhlElement("in-transit", NUMBER)], anonymous) });
  assert.equal(await w.run("login", "dhl"), 0);
  await connectAmazon(w);
  assert.deepEqual((await w.shipment(`amazon:${ORDER}#0`)).connections.sort(), ["amazon:Personal", "dhl"]);

  assert.equal(await w.run("disconnect", "dhl"), 0);

  let s = await w.shipment(`amazon:${ORDER}#0`);
  assert.deepEqual(s.connections, ["amazon:Personal"]);
  assert.equal(s.source, "Amazon");
  assert.equal(s.carrier, "DHL");
  assert.equal(s.status, "In transit");

  w.setClock("2026-09-29T11:00:00.000Z");
  const events = (assert.equal(await w.run("refresh"), 0), (await w.shipmentsFile()).events);
  s = await w.shipment(`amazon:${ORDER}#0`);
  assert.equal(s.status, "Out for delivery");
  assert.equal(s.url, ORDER_PAGE + ORDER);
  assert.deepEqual(kinds(events), [["status", `amazon:${ORDER}#0`, "Out for delivery"]]);
});

test("a refresh in flight while DHL is disconnected doesn't bring its Shipments or Health back", async (t) => {
  const dhl = dhlAccount([dhlElement("in-transit", DHL_ONLY)]);
  const w = await world(t, { transport: dhl });
  assert.equal(await w.run("login", "dhl"), 0);
  // The next inbox call hangs until the disconnect is through.
  let release;
  let asked;
  const inboxAsked = new Promise((resolve) => { asked = resolve; });
  dhl.inbox = new Promise((resolve) => { release = () => resolve(answer(dhlElement("in-transit", DHL_ONLY))); });
  const fetch = dhl.fetch.bind(dhl);
  dhl.fetch = async (url, options) => {
    if (options?.headers?.cookie && !new URL(url).searchParams.has("piececode")) asked();
    return fetch(url, options);
  };

  w.setClock("2026-09-29T11:00:00.000Z");
  const running = w.run("refresh");
  await inboxAsked;
  assert.equal(await w.run("disconnect", "dhl"), 0);
  release();
  assert.equal(await running, 0);

  assert.deepEqual((await w.shipmentsFile()).shipments, []);
  assert.equal((await w.sourcesFile()).connections.dhl.health, "not-set-up");
  assert.equal(await w.exists(join(w.stateDir, "dhl-tokens.json")), false);
});

test("disconnect refuses while that Connection's Login runs, and unknown Connections", async (t) => {
  const browser = fakeBrowser({ outcome: "open" });
  const w = await world(t, { transport: dhlAccount([]), browser });
  const login = w.run("login", "dhl");
  await browser.opened;

  assert.equal(await w.run("disconnect", "dhl"), 1);
  assert.match(w.logs.at(-1), /Finish or cancel the DHL login first/);

  w.cancel();
  assert.equal(await login, 1);
  assert.equal(await w.run("disconnect", "amazon:Personal"), 2);
  assert.equal(await w.run("disconnect"), 2);
  // Nothing to disconnect is fine: the result is the same.
  assert.equal(await w.run("disconnect", "dhl"), 0);
  assert.equal((await w.sourcesFile()).connections.dhl.health, "not-set-up");
});

// ---- Removing an Amazon account

test("removing the Amazon account turns a merged Shipment back into a DHL Shipment, quietly", async (t) => {
  const w = await world(t, { transport: dhlAccount([dhlElement("out-for-delivery", NUMBER)]) });
  assert.equal(await w.run("login", "dhl"), 0);
  await connectAmazon(w);
  assert.deepEqual(await keys(w), [`amazon:${ORDER}#0`, `amazon:${OTHER_ORDER}#0`]);

  assert.equal(await w.run("accounts", "remove", "Personal"), 0);

  const file = await w.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => s.key), [`dhl:${NUMBER}`]);
  const [s] = file.shipments;
  assert.equal(s.source, "DHL");
  assert.equal(s.account, null);
  assert.equal(s.carrier, "DHL");
  assert.deepEqual(s.connections, ["dhl"]);
  assert.equal(s.trackingNumber, NUMBER);
  assert.equal(s.url, TRACKING_PAGE + NUMBER);
  assert.equal(s.status, "Out for delivery");
  assert.equal(s.orderId, undefined);
  assert.equal(s.detail, undefined);

  // The next refresh reads it from the Sendungsliste as before: no new event.
  w.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);
  const after = await w.shipmentsFile();
  assert.deepEqual(after.shipments.map((x) => x.key), [`dhl:${NUMBER}`]);
  assert.deepEqual(after.events, []);
});

test("removing the account of a manual Order merged with its DHL twin keeps the DHL side, still marked manual", async (t) => {
  const w = await world(t, { transport: dhlAccount([dhlElement("out-for-delivery", NUMBER)]) });
  assert.equal(await w.run("login", "dhl"), 0);
  await connectAmazon(w);
  assert.equal(await w.run("add", ORDER), 0);
  assert.deepEqual((await w.shipment(`amazon:${ORDER}#0`)).connections.sort(), ["amazon:Personal", "dhl", "manual"]);

  assert.equal(await w.run("accounts", "remove", "Personal"), 0);

  const file = await w.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => s.key), [`dhl:${NUMBER}`]);
  const [s] = file.shipments;
  assert.equal(s.source, "DHL");
  assert.deepEqual(s.connections.sort(), ["dhl", "manual"]);
  assert.equal(s.status, "Out for delivery");
});

test("a DHL number added by hand that an Amazon Shipment carried stays a DHL Shipment when the account goes", async (t) => {
  const transport = fakeDhl({ [NUMBER]: answer(dhlElement("out-for-delivery", NUMBER)) });
  const w = await world(t, { transport });
  await connectAmazon(w);
  assert.equal(await w.run("add", NUMBER), 0);
  assert.equal(await w.run("refresh"), 0);
  assert.deepEqual((await w.shipment(`amazon:${ORDER}#0`)).connections, ["amazon:Personal", "manual"]);

  assert.equal(await w.run("accounts", "remove", "Personal"), 0);

  const file = await w.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => s.key), [`dhl:${NUMBER}`]);
  assert.deepEqual(file.shipments[0].connections, ["manual"]);
  assert.equal(file.shipments[0].source, "DHL");
  assert.equal(file.shipments[0].status, "Out for delivery");
});

test("a DHL number added by hand before Amazon showed it stays a DHL Shipment when the account goes", async (t) => {
  const transport = fakeDhl({ [NUMBER]: answer(dhlElement("out-for-delivery", NUMBER)) });
  const w = await world(t, { transport, history: historyWith(OTHER_ORDER) });
  assert.equal(await w.run("add", NUMBER), 0);
  assert.equal(await w.run("refresh"), 0);
  await connectAmazon(w);
  // Amazon now shows the Order that carries it: the two become one.
  const routes = { history: historyWith(ORDER, OTHER_ORDER), trackers: TRACKERS, search: {} };
  w.chrome = fakeChrome(routes);
  w.chrome.clock = () => w.now;
  w.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);
  assert.deepEqual((await w.shipment(`amazon:${ORDER}#0`)).connections, ["amazon:Personal", "manual"]);

  assert.equal(await w.run("accounts", "remove", "Personal"), 0);

  const file = await w.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => s.key), [`dhl:${NUMBER}`]);
  assert.deepEqual(file.shipments[0].connections, ["manual"]);
});

test("a manual Order ID of the removed (only) account becomes link-only at once", async (t) => {
  const w = await world(t, { history: historyWith(OTHER_ORDER, MANUAL_ORDER) });
  await connectAmazon(w);
  assert.equal(await w.run("add", MANUAL_ORDER), 0);
  assert.deepEqual((await w.shipment(`amazon:${MANUAL_ORDER}#0`)).connections, ["amazon:Personal", "manual"]);

  assert.equal(await w.run("accounts", "remove", "Personal"), 0);

  const file = await w.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => s.key), [`amazon:${MANUAL_ORDER}`]);
  const [s] = file.shipments;
  assert.deepEqual(s.connections, ["manual"]);
  assert.equal(s.linkOnly, true);
  assert.equal(s.estimate.text, "Link only · no Amazon account");
  assert.equal(s.url, ORDER_PAGE + MANUAL_ORDER);
});

test("an account added again with the same label is asked about a manual Order again", async (t) => {
  // The order search finds nothing: the account doesn't own it.
  const w = await world(t, { history: historyWith(OTHER_ORDER), search: { [MANUAL_ORDER]: historyPage([]) } });
  await connectAmazon(w);
  assert.equal(await w.run("add", MANUAL_ORDER), 0);
  assert.equal(await w.run("refresh"), 0);
  assert.equal((await w.shipment(`amazon:${MANUAL_ORDER}`)).linkOnly, true);

  assert.equal(await w.run("accounts", "remove", "Personal"), 0);
  // Its history doesn't list the Order; only asking finds it.
  w.chrome = fakeChrome({ history: historyWith(OTHER_ORDER), trackers: TRACKERS, search: { [MANUAL_ORDER]: historyWith(MANUAL_ORDER) } });
  w.chrome.clock = () => w.now;
  await connectAmazon(w);

  assert.deepEqual((await w.shipment(`amazon:${MANUAL_ORDER}#0`)).connections, ["amazon:Personal", "manual"]);
  assert.equal(await w.shipment(`amazon:${MANUAL_ORDER}`), undefined);
});

// ---- The last Connection

test("removing the last Connection leaves no Connection set up and only the manual adds", async (t) => {
  const anonymous = { [MANUAL_DHL]: answer(dhlElement("in-transit", MANUAL_DHL)) };
  const w = await world(t, { transport: dhlAccount([dhlElement("in-transit", DHL_ONLY), dhlElement("out-for-delivery", NUMBER)], anonymous) });
  assert.equal(await w.run("login", "dhl"), 0);
  await connectAmazon(w);
  assert.equal(await w.run("add", MANUAL_DHL), 0);

  assert.equal(await w.run("accounts", "remove", "Personal"), 0);
  assert.equal(await w.run("disconnect", "dhl"), 0);

  const sources = await w.sourcesFile();
  assert.deepEqual(Object.keys(sources.connections), ["dhl"]);
  assert.equal(sources.connections.dhl.health, "not-set-up");
  assert.deepEqual(await keys(w), [`dhl:${MANUAL_DHL}`]);

  assert.equal(await w.run("remove", `dhl:${MANUAL_DHL}`), 0);
  assert.deepEqual((await w.shipmentsFile()).shipments, []);
});
