// One Shipment per parcel (#27): an Amazon Shipment and a DHL Shipment with
// the same tracking number become one Shipment with Source Amazon (the row
// links to the Order) and Carrier DHL, whose Status, Estimate and Delayed come
// from DHL. All Order IDs, tracking numbers and titles here are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeChrome, fakeDhl, fakeDhlAccount, fixture, makeWorld } from "./harness.mjs";
import { historyPage, trackerPage } from "./fixtures/amazon/pages.mjs";

const ORDER = "311-0000000-0000001";
const NUMBER = "00340434000000000201"; // carried by DHL
const AMZL_ORDER = "312-0000000-0000002";
const AMZL_NUMBER = "DE0000000201"; // carried by Amazon Logistics
const DONE_ORDER = "313-0000000-0000003";
const DONE_NUMBER = "00340434000000000203"; // carried by DHL, already Delivered
const ORDER_PAGE = "https://www.amazon.de/your-orders/order-details?orderID=";

// A recorded DHL element (test/fixtures/dhl/<name>.json) under another number,
// optionally with a different delivery window.
function dhlElement(name, id, window) {
  const recorded = fixture(`dhl/${name}.json`);
  const element = JSON.parse(JSON.stringify(recorded.sendungen[0]).replaceAll(recorded.sendungen[0].id, id));
  if (window) Object.assign(element.sendungsdetails.zustellung, { zustellzeitfensterVon: window, zustellzeitfensterBis: window });
  return element;
}
const answer = (...elements) => ({ json: { sendungen: elements } });

const historyWith = (...orders) => historyPage(orders.map((orderId) => ({
  orderId,
  shipments: [{ packageIndex: 0, shipmentId: `T${orderId.slice(-4)}`, title: TITLES[orderId] }],
})));
const TITLES = { [ORDER]: "Gartenschlauch 20 m", [AMZL_ORDER]: "Kaffeebohnen 1 kg", [DONE_ORDER]: "Blumenerde 40 l" };

function trackers({ promise = "Lieferung Donnerstag, 1. Oktober" } = {}) {
  return {
    [`${ORDER}#0`]: trackerPage({
      orderId: ORDER, packageIndex: "0", shortStatus: "IN_TRANSIT", isMfn: true, trackingId: NUMBER,
      promise: { promiseMessage: promise },
    }, { carrierLine: "Versendet mit DHL" }),
    [`${AMZL_ORDER}#0`]: trackerPage({
      orderId: AMZL_ORDER, packageIndex: "0", shortStatus: "IN_TRANSIT", trackingId: AMZL_NUMBER,
    }, { carrierLine: "Versand durch Amazon" }),
    [`${DONE_ORDER}#0`]: trackerPage({
      orderId: DONE_ORDER, packageIndex: "0", shortStatus: "DELIVERED", trackingId: DONE_NUMBER,
      progressTracker: { lastTransitionPercentComplete: 100, lastReachedMilestone: "DELIVERED", numberOfReachedMilestones: 4 },
      promise: { promiseMessage: "Zugestellt: 28. September" },
    }, { carrierLine: "Versendet mit DHL" }),
  };
}

// A DHL account whose Sendungsliste lists `elements` (complete in the inbox).
function dhlAccount(elements, anonymous) {
  const account = fakeDhlAccount({ inbox: answer(...elements), enrich: () => answer(...account.listed), anonymous });
  account.listed = elements;
  return account;
}

// Counts the anonymous lookups per tracking number.
function counted(transport) {
  const lookups = [];
  return {
    lookups,
    async fetch(url, options = {}) {
      const u = new URL(url);
      const cookie = options.headers?.cookie;
      if (u.pathname === "/int-verfolgen/data/search" && !cookie) lookups.push(u.searchParams.get("piececode"));
      return transport.fetch(url, options);
    },
  };
}

async function world(t, { transport, routes }) {
  const w = await makeWorld({ transport, chrome: fakeChrome(routes) });
  t.after(() => w.cleanup());
  return w;
}

async function connectAmazon(w, label = "Personal") {
  assert.equal(await w.run("accounts", "add", label, "--accept-risk"), 0);
  assert.equal(await w.run("login", `amazon:${label}`), 0);
}

const merged = (file) => file.shipments.filter((s) => s.trackingNumber === NUMBER);

test("DHL first, then Amazon: the same tracking number is one Shipment that both Connections know", async (t) => {
  const dhl = counted(dhlAccount([dhlElement("out-for-delivery", NUMBER)]));
  const w = await world(t, { transport: dhl, routes: { history: historyWith(ORDER, AMZL_ORDER), trackers: trackers() } });
  assert.equal(await w.run("login", "dhl"), 0);
  await connectAmazon(w);
  w.setClock("2026-09-29T11:00:00.000Z");

  assert.equal(await w.run("refresh"), 0);

  const file = await w.shipmentsFile();
  assert.equal(merged(file).length, 1);
  assert.equal(file.shipments.length, 2);
  const s = await w.shipment(`amazon:${ORDER}#0`);
  assert.deepEqual({ ...s, connections: [...s.connections].sort() }, {
    key: `amazon:${ORDER}#0`,
    direction: "Incoming",
    source: "Amazon",
    account: "Personal",
    carrier: "DHL",
    connections: ["amazon:Personal", "dhl"],
    title: "Gartenschlauch 20 m",
    // DHL's detail, not Amazon's "In transit · Thu 1 Oct".
    status: "Out for delivery",
    estimate: s.estimate,
    delayed: false,
    orderId: ORDER,
    url: ORDER_PAGE + ORDER,
    trackingNumber: NUMBER,
    changedAt: "2026-09-29T10:00:00.000Z",
    discoveredAt: "2026-09-29T10:00:00.000Z",
    lastSeenAt: s.lastSeenAt, // Amazon's paced read, after 11:00
    detail: "DHL",
    lastWindowTo: "2026-09-29",
  });
  assert.deepEqual(s.estimate, { from: "2026-09-29", to: "2026-09-29", text: "Tue 29 Sep" });
  // The Sendungsliste knows the number, so there is no anonymous lookup.
  assert.deepEqual(dhl.lookups, []);
});

test("Amazon first, then DHL: the Sendungsliste's element joins the Amazon Shipment", async (t) => {
  const dhl = dhlAccount([dhlElement("out-for-delivery", NUMBER)], { [NUMBER]: answer(dhlElement("out-for-delivery", NUMBER)) });
  const w = await world(t, { transport: dhl, routes: { history: historyWith(ORDER), trackers: trackers() } });
  await connectAmazon(w);
  assert.equal((await w.shipment(`amazon:${ORDER}#0`)).status, "In transit");

  assert.equal(await w.run("login", "dhl"), 0);

  const file = await w.shipmentsFile();
  assert.equal(file.shipments.length, 1);
  const [s] = file.shipments;
  assert.equal(s.key, `amazon:${ORDER}#0`);
  assert.deepEqual([...s.connections].sort(), ["amazon:Personal", "dhl"]);
  assert.equal(s.source, "Amazon");
  assert.equal(s.carrier, "DHL");
  assert.equal(s.title, "Gartenschlauch 20 m");
  assert.equal(s.url, ORDER_PAGE + ORDER);
  assert.equal(s.status, "Out for delivery");
});

test("the merged Shipment's Estimate and Delayed follow DHL, not Amazon's promise", async (t) => {
  const dhl = dhlAccount([dhlElement("in-transit", NUMBER, "2026-09-30")]);
  const routes = { history: historyWith(ORDER), trackers: trackers() };
  const w = await world(t, { transport: dhl, routes });
  assert.equal(await w.run("login", "dhl"), 0);
  await connectAmazon(w);

  // Amazon's promise moves two days later; DHL's window stays.
  routes.trackers = trackers({ promise: "Lieferung Samstag, 3. Oktober" });
  w.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);
  let s = await w.shipment(`amazon:${ORDER}#0`);
  assert.equal(s.status, "In transit");
  assert.deepEqual(s.estimate, { from: "2026-09-30", to: "2026-09-30", text: "Wed 30 Sep" });
  assert.equal(s.delayed, false);

  // DHL's window moves a day later.
  dhl.listed = [dhlElement("in-transit", NUMBER, "2026-10-01")];
  dhl.inbox = answer(...dhl.listed);
  w.setClock("2026-09-29T12:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);
  s = await w.shipment(`amazon:${ORDER}#0`);
  assert.deepEqual(s.estimate, { from: "2026-10-01", to: "2026-10-01", text: "Thu 1 Oct" });
  assert.equal(s.delayed, true);
});

test("without a DHL Connection, DHL numbers learned from Amazon are looked up anonymously, once per run", async (t) => {
  const dhl = counted(fakeDhl({ [NUMBER]: answer(dhlElement("out-for-delivery", NUMBER)) }));
  const w = await world(t, { transport: dhl, routes: { history: historyWith(ORDER, AMZL_ORDER, DONE_ORDER), trackers: trackers() } });
  await connectAmazon(w);
  assert.deepEqual(dhl.lookups, []);

  w.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);

  // Not the Amazon Logistics number, not the Delivered one.
  assert.deepEqual(dhl.lookups, [NUMBER]);
  const s = await w.shipment(`amazon:${ORDER}#0`);
  assert.deepEqual(s.connections, ["amazon:Personal"]);
  assert.equal(s.source, "Amazon");
  assert.equal(s.carrier, "DHL");
  assert.equal(s.url, ORDER_PAGE + ORDER);
  assert.equal(s.status, "Out for delivery");
  assert.deepEqual(s.estimate, { from: "2026-09-29", to: "2026-09-29", text: "Tue 29 Sep" });
  assert.equal((await w.shipment(`amazon:${AMZL_ORDER}#0`)).status, "In transit");
  assert.equal((await w.sourcesFile()).connections.dhl, undefined);

  w.setClock("2026-09-29T12:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);
  assert.deepEqual(dhl.lookups, [NUMBER, NUMBER]);
});

test("a DHL number Amazon shows for the first time during a run is looked up in that same run", async (t) => {
  const dhl = counted(fakeDhl({ [NUMBER]: answer(dhlElement("out-for-delivery", NUMBER)) }));
  const routes = { history: historyWith(AMZL_ORDER), trackers: trackers() };
  const w = await world(t, { transport: dhl, routes });
  await connectAmazon(w);

  routes.history = historyWith(ORDER, AMZL_ORDER);
  w.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);

  assert.deepEqual(dhl.lookups, [NUMBER]);
  assert.equal((await w.shipment(`amazon:${ORDER}#0`)).status, "Out for delivery");
});

test("a number DHL doesn't know yet keeps Amazon's Status and Estimate", async (t) => {
  const dhl = counted(fakeDhl({ [NUMBER]: answer(dhlElement("unknown", NUMBER)) }));
  const w = await world(t, { transport: dhl, routes: { history: historyWith(ORDER), trackers: trackers() } });
  await connectAmazon(w);

  w.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);

  assert.deepEqual(dhl.lookups, [NUMBER]);
  const s = await w.shipment(`amazon:${ORDER}#0`);
  assert.equal(s.status, "In transit");
  assert.equal(s.estimate.text, "Lieferung Donnerstag, 1. Oktober");
});

test("a manual add of a number an Amazon Shipment carries joins that Shipment", async (t) => {
  const dhl = counted(fakeDhl({ [NUMBER]: answer(dhlElement("out-for-delivery", NUMBER)) }));
  const w = await world(t, { transport: dhl, routes: { history: historyWith(ORDER), trackers: trackers() } });
  await connectAmazon(w);

  assert.equal(await w.run("add", NUMBER), 0);
  assert.equal(w.output.at(-1), "Already tracked");
  assert.deepEqual((await w.shipmentsFile()).shipments.map((s) => s.key), [`amazon:${ORDER}#0`]);
  w.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);

  const file = await w.shipmentsFile();
  assert.equal(file.shipments.length, 1);
  assert.deepEqual(file.shipments[0].connections, ["amazon:Personal", "manual"]);
  assert.equal(file.shipments[0].status, "Out for delivery");
  assert.deepEqual(dhl.lookups, [NUMBER]);
});

test("a manual add that Amazon later shows becomes the Amazon Shipment, keeping DHL's detail", async (t) => {
  const dhl = counted(fakeDhl({ [NUMBER]: answer(dhlElement("out-for-delivery", NUMBER)) }));
  const w = await world(t, { transport: dhl, routes: { history: historyWith(ORDER), trackers: trackers() } });
  assert.equal(await w.run("add", NUMBER), 0);
  assert.equal(await w.run("refresh"), 0);
  assert.equal((await w.shipment(`dhl:${NUMBER}`)).status, "Out for delivery");

  w.setClock("2026-09-29T11:00:00.000Z");
  await connectAmazon(w);

  const file = await w.shipmentsFile();
  assert.equal(file.shipments.length, 1);
  const [s] = file.shipments;
  assert.equal(s.key, `amazon:${ORDER}#0`);
  assert.deepEqual(s.connections, ["amazon:Personal", "manual"]);
  assert.equal(s.source, "Amazon");
  assert.equal(s.account, "Personal");
  assert.equal(s.carrier, "DHL");
  assert.equal(s.url, ORDER_PAGE + ORDER);
  assert.equal(s.status, "Out for delivery");
  assert.equal(s.discoveredAt, "2026-09-29T10:00:00.000Z");
});
