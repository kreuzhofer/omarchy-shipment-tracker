// Notification events (spec #21, "Event generation") at the refresh seam: a
// fake DHL account whose Sendungsliste the test rewrites between runs, then
// only shipments.json `events[]` and `lastEventId` are looked at. All tracking
// numbers and names here are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeChrome, fakeDhl, fakeDhlAccount, fakeImageCdn, fixture, makeWorld } from "./harness.mjs";
import { historyPage, signInPage, trackerPage } from "./fixtures/amazon/pages.mjs";

const A = "00340434000000000201";
const B = "00340434000000000202";
const C = "00340434000000000203";
const D = "00340434000000000204";
const E = "00340434000000000205";

// What DHL would send for a parcel in each Status: the Incoming in-transit
// element of the account fixture, with the fields DHL changes for it.
const STATUS_PATCHES = {
  Announced: (d, v) => { v.fortschritt = 1; },
  "In transit": () => {},
  "Out for delivery": (d, v) => { v.fortschritt = 4; },
  "Ready for pickup": (d, v, z) => { z.abholcodeAvailable = true; say(v, "Die Sendung wurde in die Packstation 17 eingeliefert."); },
  Problem: (d, v) => say(v, "Die Sendung konnte nicht zugestellt werden."),
  Returning: (d) => { d.retoure = true; },
  Delivered: (d, v) => { d.istZugestellt = true; v.fortschritt = 5; },
  Returned: (d, v) => { d.retoure = true; d.istZugestellt = true; v.fortschritt = 5; },
};

function say(verlauf, status) {
  verlauf.status = status;
  verlauf.events.push({ datum: "2026-09-29T09:10:00+02:00", status, ruecksendung: false });
}

// parcel(id, status, { direction, title, window: [from, to], extraEvent })
function parcel(id, status, { direction = "Incoming", title = "Beispiel Shop GmbH", window = null, extraEvent = null } = {}) {
  const e = structuredClone(fixture("dhl/account/enriched.json").sendungen[0]);
  e.id = id;
  e.sendungsinfo.gesuchteSendungsnummer = id;
  e.sendungsinfo.sendungsname = title;
  e.sendungsinfo.sendungsrichtung = direction === "Outgoing" ? "ABGEHEND" : "ANKOMMEND";
  const d = e.sendungsdetails;
  d.sendungsnummern.sendungsnummer = id;
  if (direction === "Outgoing") d.empfaenger = { name: title };
  STATUS_PATCHES[status](d, d.sendungsverlauf, d.zustellung);
  if (window) [d.zustellung.zustellzeitfensterVon, d.zustellung.zustellzeitfensterBis] = window;
  if (extraEvent) say(d.sendungsverlauf, extraEvent);
  return e;
}

// A fake DHL account whose Sendungsliste is `list` (every element complete).
function account(list) {
  const dhl = fakeDhlAccount({});
  dhl.show = (elements) => {
    dhl.inbox = { json: { sendungen: elements, mergedAnonymousShipmentListIds: [], rateLimited: false } };
    dhl.enrich = dhl.inbox;
  };
  dhl.show(list);
  return dhl;
}

let minute = 0;
async function refreshWith(world, dhl, list) {
  dhl.show(list);
  world.setClock(new Date(Date.parse("2026-09-29T11:00:00.000Z") + ++minute * 60000).toISOString());
  assert.equal(await world.run("refresh"), 0);
  return (await world.shipmentsFile()).events;
}

// Logged in with `first` as the Sendungsliste; the login's first sync is done.
async function connected(t, first = []) {
  const dhl = account(first);
  const world = await makeWorld({ transport: dhl });
  t.after(() => world.cleanup());
  assert.equal(await world.run("login", "dhl"), 0);
  return { world, dhl };
}

// Variant B titles (#67), per Status, for `item`.
const TITLES = {
  "Out for delivery": (i) => `Your ${i} is out for delivery`,
  "Ready for pickup": (i) => `Your ${i} is ready for pickup`,
  Problem: (i) => `Problem with your ${i}`,
  Returning: (i) => `Your ${i} is on its way back`,
  Delivered: (i) => `Your ${i} was delivered`,
  Returned: (i) => `Your ${i} was returned`,
};

const kinds = (events) => events.map((e) => [e.kind, e.key ?? null, e.status ?? null]);

// ---- Incoming

for (const status of ["Out for delivery", "Ready for pickup", "Problem", "Returning", "Delivered", "Returned"]) {
  test(`Incoming: a transition into ${status} is a status event that opens the Shipment's page`, async (t) => {
    const { world, dhl } = await connected(t, [parcel(A, "In transit")]);

    const events = await refreshWith(world, dhl, [parcel(A, status)]);

    assert.equal(events.length, 1);
    const [e] = events;
    assert.equal(e.kind, "status");
    assert.equal(e.key, `dhl:${A}`);
    assert.equal(e.status, status);
    assert.equal(e.title, TITLES[status]("parcel from Beispiel Shop GmbH"));
    assert.match(e.body, /^DHL\b/);
    assert.equal("image" in e, false);
    assert.equal(e.url, `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${A}`);
  });
}

test("Incoming: Announced → In transit and a new event within the same Status produce nothing", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Announced"), parcel(B, "Out for delivery")]);

  const events = await refreshWith(world, dhl, [parcel(A, "In transit"), parcel(B, "Out for delivery", { extraEvent: "Die Sendung wurde in das Zustellfahrzeug geladen." })]);

  assert.deepEqual(events, []);
});

test("Incoming: a Status the rules don't name (Problem → In transit) produces nothing", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Problem")]);

  assert.deepEqual(await refreshWith(world, dhl, [parcel(A, "In transit")]), []);
});

test("Incoming: becoming Delayed is a delayed event with the new Estimate", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit", { window: ["2026-09-30", "2026-09-30"] })]);

  const events = await refreshWith(world, dhl, [parcel(A, "In transit", { window: ["2026-10-02", "2026-10-02"] })]);

  assert.deepEqual(kinds(events), [["delayed", `dhl:${A}`, "In transit"]]);
  assert.equal(events[0].title, "Your parcel from Beispiel Shop GmbH is delayed");
  assert.equal(events[0].body, "DHL · Fri 2 Oct");
  assert.equal(events[0].url, `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${A}`);

  // Still Delayed next run: nothing new to say.
  assert.deepEqual(await refreshWith(world, dhl, [parcel(A, "In transit", { window: ["2026-10-02", "2026-10-02"] })]), []);
});

test("a Status change and Delayed in the same run give one status event", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit", { window: ["2026-09-30", "2026-09-30"] })]);

  const events = await refreshWith(world, dhl, [parcel(A, "Out for delivery", { window: ["2026-10-01", "2026-10-01"] })]);

  assert.deepEqual(kinds(events), [["status", `dhl:${A}`, "Out for delivery"]]);
});

test("Incoming: a newly discovered Shipment is a new event naming the sender", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit")]);

  const events = await refreshWith(world, dhl, [parcel(A, "In transit"), parcel(B, "Announced", { title: "Muster Versand" })]);

  assert.deepEqual(kinds(events), [["new", `dhl:${B}`, "Announced"]]);
  assert.equal(events[0].title, "New shipment: parcel from Muster Versand");
  assert.equal(events[0].body, "DHL · Announced");
  assert.equal(events[0].url, `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${B}`);
});

test("a newly discovered Shipment is only new, even when it arrives Out for delivery", async (t) => {
  const { world, dhl } = await connected(t, []);

  const events = await refreshWith(world, dhl, [parcel(A, "Out for delivery")]);

  assert.deepEqual(kinds(events), [["new", `dhl:${A}`, "Out for delivery"]]);
});

// ---- Titles: item, truncation

test("a DHL parcel with its item known from mail is called by the item", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit")]);
  // What the mail strategy (#59) records on a DHL Shipment.
  const file = await world.shipmentsFile();
  file.shipments.find((s) => s.key === `dhl:${A}`).itemTitle = "Winterstiefel Gr. 42";
  await writeFile(join(world.stateDir, "shipments.json"), JSON.stringify(file));

  const events = await refreshWith(world, dhl, [parcel(A, "Ready for pickup")]);

  assert.deepEqual(kinds(events), [["status", `dhl:${A}`, "Ready for pickup"]]);
  assert.equal(events[0].title, "Your Winterstiefel Gr. 42 is ready for pickup");
  assert.match(events[0].body, /^DHL\b/);
});

test("a long item or sender is cut to about 40 characters, at a word, with an ellipsis", async (t) => {
  const long = "Beispiel Versandhandel und Logistik Gesellschaft mbH";
  const { world, dhl } = await connected(t, [parcel(A, "In transit", { title: long })]);

  const events = await refreshWith(world, dhl, [parcel(A, "Delivered", { title: long }), parcel(B, "Announced", { title: "Muster Versand" })]);

  const byKey = Object.fromEntries(events.map((e) => [e.key, e.title]));
  assert.equal(byKey[`dhl:${A}`], "Your parcel from Beispiel Versandhandel und Logistik… was delivered");
  assert.equal(byKey[`dhl:${B}`], "New shipment: parcel from Muster Versand");
});

// ---- Outgoing

for (const status of ["Delivered", "Problem", "Returning"]) {
  test(`Outgoing: a transition into ${status} is a status event`, async (t) => {
    const { world, dhl } = await connected(t, [parcel(A, "In transit", { direction: "Outgoing", title: "Erika Musterfrau" })]);

    const events = await refreshWith(world, dhl, [parcel(A, status, { direction: "Outgoing", title: "Erika Musterfrau" })]);

    assert.deepEqual(kinds(events), [["status", `dhl:${A}`, status]]);
    assert.equal(events[0].title, {
      Delivered: "Your parcel to Erika Musterfrau was delivered",
      Problem: "Problem with your parcel to Erika Musterfrau",
      Returning: "Your parcel to Erika Musterfrau is on its way back",
    }[status]);
    assert.match(events[0].body, /^DHL\b/);
  });
}

test("Outgoing: Out for delivery, Ready for pickup, Delayed and discovery produce nothing", async (t) => {
  const out = { direction: "Outgoing", title: "Erika Musterfrau" };
  const { world, dhl } = await connected(t, [
    parcel(A, "Announced", out), parcel(B, "In transit", out), parcel(C, "In transit", { ...out, window: ["2026-09-30", "2026-09-30"] }),
  ]);

  const events = await refreshWith(world, dhl, [
    parcel(A, "Out for delivery", out), parcel(B, "Ready for pickup", out),
    parcel(C, "In transit", { ...out, window: ["2026-10-03", "2026-10-03"] }), parcel(D, "In transit", out),
  ]);

  assert.deepEqual(events, []);
  assert.equal((await world.shipment(`dhl:${C}`)).delayed, true);
});

// ---- First sync

test("a Connection's first sync after setup produces no events, not even for Status", async (t) => {
  const { world } = await connected(t, [parcel(A, "Out for delivery"), parcel(B, "Ready for pickup"), parcel(C, "Delivered")]);

  const file = await world.shipmentsFile();
  assert.deepEqual(file.events, []);
  assert.equal(file.lastEventId, 0);
});

test("a first sync that failed leaves the next successful sync as the first: still no new events", async (t) => {
  const dhl = account([parcel(A, "In transit")]);
  const world = await makeWorld({ transport: dhl });
  t.after(() => world.cleanup());
  const inbox = dhl.inbox;
  dhl.inbox = { network: true };
  dhl.enrich = { network: true };
  await world.run("login", "dhl");
  dhl.inbox = inbox;

  assert.deepEqual(await refreshWith(world, dhl, [parcel(A, "In transit"), parcel(B, "Announced")]), []);
  assert.deepEqual(kinds(await refreshWith(world, dhl, [parcel(A, "In transit"), parcel(B, "Announced"), parcel(C, "Announced")])),
    [["new", `dhl:${C}`, "Announced"]]);
});

test("the first sync after a re-login produces no new events; the next refresh does again", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit")]);
  // The session ends: DHL rejects the refresh token.
  const issue = dhl.token;
  dhl.token = () => ({ status: 400, json: { error: "invalid_grant" } });
  await refreshWith(world, dhl, [parcel(A, "In transit")]);
  assert.equal((await world.sourcesFile()).connections.dhl.health, "needs-login");
  dhl.token = issue;

  dhl.show([parcel(A, "In transit"), parcel(B, "Announced"), parcel(C, "In transit")]);
  assert.equal(await world.run("login", "dhl"), 0);
  assert.deepEqual((await world.shipmentsFile()).events, []);

  const events = await refreshWith(world, dhl, [parcel(A, "In transit"), parcel(B, "Announced"), parcel(C, "In transit"), parcel(D, "Announced")]);
  assert.deepEqual(kinds(events), [["new", `dhl:${D}`, "Announced"]]);
});

// ---- Manual adds

test("a manual add is never new and its first lookup notifies nothing; later transitions do", async (t) => {
  const NUMBER = "00340434000000000299";
  const response = (status) => ({ json: { sendungen: [parcel(NUMBER, status)] } });
  const responses = { [NUMBER]: response("Out for delivery") };
  const world = await makeWorld({ transport: fakeDhl(responses) });
  t.after(() => world.cleanup());

  await world.run("add", NUMBER);
  await world.run("refresh");
  assert.deepEqual((await world.shipmentsFile()).events, []);

  responses[NUMBER] = response("Delivered");
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");
  assert.deepEqual(kinds((await world.shipmentsFile()).events), [["status", `dhl:${NUMBER}`, "Delivered"]]);
});

test("a manual add whose first lookup failed notifies nothing on its first reading", async (t) => {
  const NUMBER = "00340434000000000298";
  const responses = { [NUMBER]: { status: 503, text: "unavailable" } };
  const world = await makeWorld({ transport: fakeDhl(responses) });
  t.after(() => world.cleanup());

  await world.run("add", NUMBER);
  await world.run("refresh");
  responses[NUMBER] = { json: { sendungen: [parcel(NUMBER, "Out for delivery")] } };
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");

  assert.equal((await world.shipment(`dhl:${NUMBER}`)).status, "Out for delivery");
  assert.deepEqual((await world.shipmentsFile()).events, []);
});

test("a manual add the Sendungsliste then lists is not announced as new", async (t) => {
  const { world, dhl } = await connected(t, []);
  await world.run("add", A);

  assert.deepEqual(await refreshWith(world, dhl, [parcel(A, "In transit")]), []);
});

// ---- Collapse, ids, never twice

test("more than 3 Shipment events in one run collapse into one summary", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit"), parcel(B, "In transit"), parcel(C, "In transit")]);

  const events = await refreshWith(world, dhl, [
    parcel(A, "Out for delivery"), parcel(B, "Delivered"), parcel(C, "Problem"), parcel(D, "Announced", { title: "Muster Versand" }),
  ]);

  assert.equal(events.length, 1);
  const { id, ...rest } = events[0];
  assert.equal(id, 1);
  assert.deepEqual(rest, {
    kind: "summary",
    count: 4,
    title: "4 Shipments updated",
    body: "Beispiel Shop GmbH, Beispiel Shop GmbH, Beispiel Shop GmbH and 1 more",
  });
});

test("exactly 3 Shipment events stay separate", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit"), parcel(B, "In transit")]);

  const events = await refreshWith(world, dhl, [parcel(A, "Out for delivery"), parcel(B, "Delivered"), parcel(C, "Announced")]);

  assert.deepEqual(kinds(events).sort(), [["new", `dhl:${C}`, "Announced"], ["status", `dhl:${A}`, "Out for delivery"], ["status", `dhl:${B}`, "Delivered"]]);
  assert.deepEqual(events.map((e) => e.id), [1, 2, 3]);
});

test("event ids keep increasing across runs; events[] holds only the last run's; nothing is said twice", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit"), parcel(B, "In transit")]);

  const first = await refreshWith(world, dhl, [parcel(A, "Out for delivery"), parcel(B, "In transit")]);
  assert.deepEqual(first.map((e) => e.id), [1]);

  const quiet = await refreshWith(world, dhl, [parcel(A, "Out for delivery"), parcel(B, "In transit")]);
  assert.deepEqual(quiet, []);
  assert.equal((await world.shipmentsFile()).lastEventId, 1);

  const second = await refreshWith(world, dhl, [parcel(A, "Delivered"), parcel(B, "Out for delivery")]);
  assert.deepEqual(second.map((e) => e.id), [2, 3]);
  assert.deepEqual(kinds(second), [["status", `dhl:${A}`, "Delivered"], ["status", `dhl:${B}`, "Out for delivery"]]);
  assert.equal((await world.shipmentsFile()).lastEventId, 3);
});

test("a failed run keeps the Shipments and says nothing; the change is told once it is read", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit")]);

  dhl.show([]);
  dhl.inbox = { status: 503, text: "unavailable" };
  world.setClock("2026-09-29T12:00:00.000Z");
  await world.run("refresh");
  assert.deepEqual((await world.shipmentsFile()).events, []);

  const events = await refreshWith(world, dhl, [parcel(A, "Out for delivery")]);
  assert.deepEqual(kinds(events), [["status", `dhl:${A}`, "Out for delivery"]]);
});

test("Shipments from before notification events existed are not announced as new", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit")]);
  // shipments.json as #24 wrote it: no `notified` marks yet.
  const file = await world.shipmentsFile();
  for (const s of file.shipments) delete s.notified;
  await writeFile(join(world.stateDir, "shipments.json"), JSON.stringify(file));

  assert.deepEqual(await refreshWith(world, dhl, [parcel(A, "In transit")]), []);
  assert.deepEqual(kinds(await refreshWith(world, dhl, [parcel(A, "Delivered")])), [["status", `dhl:${A}`, "Delivered"]]);
});

test("a dropped key never produces an event", async (t) => {
  const { world, dhl } = await connected(t, []);
  const file = await world.shipmentsFile();
  file.dropped = [{ key: `dhl:${E}`, at: "2026-09-20T10:00:00.000Z" }];
  await writeFile(join(world.stateDir, "shipments.json"), JSON.stringify(file));

  assert.deepEqual(await refreshWith(world, dhl, [parcel(E, "Out for delivery")]), []);
});

// ---- Amazon Connections

const ORDER_1 = "305-0000000-0000001";
const ORDER_2 = "305-0000000-0000002";
const AMAZON_PAGE = "https://www.amazon.de/your-orders/order-details?orderID=";

const order = (orderId, title) => ({ orderId, shipments: [{ packageIndex: 0, shipmentId: `T${orderId.slice(-4)}`, title }] });
const tracker = (orderId, shortStatus, promiseMessage = "Lieferung morgen") =>
  trackerPage({ orderId, packageIndex: "0", shortStatus, progressTracker: {}, promise: { promiseMessage } });

async function amazonAccount(t, routes) {
  const world = await makeWorld({ chrome: fakeChrome(routes) });
  t.after(() => world.cleanup());
  assert.equal(await world.run("accounts", "add", "Personal", "--accept-risk"), 0);
  assert.equal(await world.run("login", "amazon:Personal"), 0);
  return world;
}

async function amazonRefresh(world) {
  minute += 1;
  world.setClock(new Date(Date.parse("2026-09-29T11:00:00.000Z") + minute * 60000).toISOString());
  assert.equal(await world.run("refresh"), 0);
  return (await world.shipmentsFile()).events;
}

test("Amazon: the Login's first sync announces nothing; a later refresh announces a new Order from the account", async (t) => {
  const routes = {
    history: historyPage([order(ORDER_1, "Gartenschlauch 20 m")]),
    trackers: { [`${ORDER_1}#0`]: tracker(ORDER_1, "OUT_FOR_DELIVERY") },
  };
  const world = await amazonAccount(t, routes);
  assert.equal((await world.shipment(`amazon:${ORDER_1}#0`)).status, "Out for delivery");
  assert.deepEqual((await world.shipmentsFile()).events, []);

  routes.history = historyPage([order(ORDER_2, "Kabel & Adapter-Set"), order(ORDER_1, "Gartenschlauch 20 m")]);
  routes.trackers[`${ORDER_2}#0`] = tracker(ORDER_2, "SHIPPED");
  const events = await amazonRefresh(world);

  assert.deepEqual(kinds(events), [["new", `amazon:${ORDER_2}#0`, "In transit"]]);
  assert.equal(events[0].title, "New shipment: Kabel & Adapter-Set");
  assert.equal(events[0].body, "Amazon · Personal · In transit · Lieferung morgen");
  assert.equal(events[0].url, AMAZON_PAGE + ORDER_2);
});

test("Amazon: a transition into Delivered is a status event that opens the Order", async (t) => {
  const routes = {
    history: historyPage([order(ORDER_1, "Gartenschlauch 20 m")]),
    trackers: { [`${ORDER_1}#0`]: tracker(ORDER_1, "SHIPPED") },
  };
  const world = await amazonAccount(t, routes);

  routes.trackers[`${ORDER_1}#0`] = tracker(ORDER_1, "DELIVERED", "Zugestellt: 29. September");
  const events = await amazonRefresh(world);

  assert.deepEqual(kinds(events), [["status", `amazon:${ORDER_1}#0`, "Delivered"]]);
  assert.equal(events[0].title, "Your Gartenschlauch 20 m was delivered");
  assert.equal(events[0].body, "Amazon · Personal · Delivered Tue 29 Sep");
  assert.equal(events[0].url, AMAZON_PAGE + ORDER_1);
});

test("Amazon: the first sync after a re-login announces nothing new", async (t) => {
  const routes = {
    history: historyPage([order(ORDER_1, "Gartenschlauch 20 m")]),
    trackers: { [`${ORDER_1}#0`]: tracker(ORDER_1, "SHIPPED") },
  };
  const world = await amazonAccount(t, routes);
  routes.history = { url: "https://www.amazon.de/ap/signin", html: signInPage() };
  await amazonRefresh(world);
  assert.equal((await world.sourcesFile()).connections["amazon:Personal"].health, "needs-login");

  routes.history = historyPage([order(ORDER_2, "Kabel & Adapter-Set"), order(ORDER_1, "Gartenschlauch 20 m")]);
  routes.trackers[`${ORDER_2}#0`] = tracker(ORDER_2, "SHIPPED");
  assert.equal(await world.run("login", "amazon:Personal"), 0);

  assert.equal((await world.shipment(`amazon:${ORDER_2}#0`)).status, "In transit");
  assert.deepEqual((await world.shipmentsFile()).events, []);
  assert.deepEqual(await amazonRefresh(world), []);
});

test("Amazon: a dropped key never produces an event", async (t) => {
  const routes = { history: historyPage([]), trackers: {} };
  const world = await amazonAccount(t, routes);
  const file = await world.shipmentsFile();
  file.dropped = [{ key: `amazon:${ORDER_1}#0`, at: "2026-09-20T10:00:00.000Z" }];
  await writeFile(join(world.stateDir, "shipments.json"), JSON.stringify(file));

  routes.history = historyPage([order(ORDER_1, "Gartenschlauch 20 m")]);
  routes.trackers[`${ORDER_1}#0`] = tracker(ORDER_1, "OUT_FOR_DELIVERY");
  assert.deepEqual(await amazonRefresh(world), []);
});

test("Amazon: an event carries the cached product image, and none once the file is gone", async (t) => {
  const routes = {
    history: historyPage([order(ORDER_1, "USB-C Dock mit sehr langem Produktnamen und Zubehör")]),
    trackers: { [`${ORDER_1}#0`]: tracker(ORDER_1, "SHIPPED") },
  };
  const cdn = fakeImageCdn();
  const world = await makeWorld({ chrome: fakeChrome(routes), transport: cdn });
  t.after(() => world.cleanup());
  assert.equal(await world.run("accounts", "add", "Personal", "--accept-risk"), 0);
  assert.equal(await world.run("login", "amazon:Personal"), 0);
  assert.equal(await world.run("refresh"), 0);
  const { image } = await world.shipment(`amazon:${ORDER_1}#0`);
  assert.equal(image, join(world.stateDir, "images", "example.jpg"));

  routes.trackers[`${ORDER_1}#0`] = tracker(ORDER_1, "OUT_FOR_DELIVERY", "Heute 14–17 Uhr");
  const events = await amazonRefresh(world);
  assert.deepEqual(kinds(events), [["status", `amazon:${ORDER_1}#0`, "Out for delivery"]]);
  assert.equal(events[0].title, "Your USB-C Dock mit sehr langem Produktnamen… is out for delivery");
  assert.equal(events[0].body, "Amazon · Personal · Heute 14–17 Uhr");
  assert.equal(events[0].image, image);

  // The cached file disappears and can't be fetched again: no image, not a stale path.
  await rm(image);
  cdn.answer = () => ({ status: 404, contentType: "text/html", bytes: Buffer.from("gone") });
  routes.trackers[`${ORDER_1}#0`] = tracker(ORDER_1, "DELIVERED", "Zugestellt");
  const later = await amazonRefresh(world);
  assert.deepEqual(kinds(later), [["status", `amazon:${ORDER_1}#0`, "Delivered"]]);
  assert.equal("image" in later[0], false);
});
