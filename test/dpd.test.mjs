// DPD as a second Carrier (#83), at the one seam: manual adds and Amazon
// Shipments carried by DPD, looked up anonymously on my.dpd.de's tracking
// page (fakeDpd answers its redirect chain and session cookie as seen live).
// Every number, Order ID and title here is synthetic; the pages are built
// from the documented element ids (fixtures/dpd/pages.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeChrome, fakeDhl, fakeDpd, fakeMail, makeWorld } from "./harness.mjs";
import { changedPage, errorPage, trackingPage } from "./fixtures/dpd/pages.mjs";
import { historyPage, trackerPage } from "./fixtures/amazon/pages.mjs";
import { amazonDpdNotice, dpdPredict, dpdShopShipped, dpdSoon, messageList, otherCarrier, softeriaAccount } from "./fixtures/mail/softeria.mjs";

const NUMBER = "09990000000001";
const OTHER = "09990000000002";
const DHL_NUMBER = "00340434000000000011";
const DPD_PAGE = "https://my.dpd.de/redirect.aspx?action=12&parcelno=";

const outForDelivery = () => trackingPage({
  status: "In Zustellung - 29.09.2026", image: 4,
  dates: { Start: "26.09.", OnTheRoad: "27.09.", DeliveryDepot: "29.09.", CarLoad: "29.09." },
});
const inTransit = () => trackingPage({ status: "Unterwegs", image: 2, dates: { Start: "26.09.", OnTheRoad: "27.09." } });
const delivered = () => trackingPage({
  status: "Zugestellt - 28.09.2026", image: 5,
  dates: { Start: "25.09.", OnTheRoad: "26.09.", DeliveryDepot: "28.09.", CarLoad: "28.09.", Delivered: "28.09." },
});

async function dpdWorld(t, routes, options = {}) {
  const transport = fakeDpd(routes, options.dhl ?? fakeDhl({}));
  const world = await makeWorld({ transport, ...options.world });
  t.after(() => world.cleanup());
  return world;
}

test("a pasted DPD number is a DPD Shipment, looked up anonymously on my.dpd.de by the next refresh", async (t) => {
  const world = await dpdWorld(t, { [NUMBER]: outForDelivery() });

  assert.equal(await world.run("add", ` ${NUMBER.slice(0, 7)} ${NUMBER.slice(7)} `), 0);
  const added = await world.shipment(`dpd:${NUMBER}`);
  assert.deepEqual([added.source, added.carrier, added.status, added.estimate.text], ["DPD", "DPD", "Unknown", "Looking up…"]);

  world.setClock("2026-09-29T10:05:00.000Z");
  assert.equal(await world.run("refresh"), 0);

  const file = await world.shipmentsFile();
  assert.deepEqual(file.shipments, [{
    key: `dpd:${NUMBER}`,
    direction: "Incoming",
    source: "DPD",
    account: null,
    carrier: "DPD",
    connections: ["manual"],
    title: NUMBER,
    status: "Out for delivery",
    estimate: { from: "2026-09-29", to: "2026-09-29", text: "Tue 29 Sep" },
    delayed: false,
    trackingNumber: NUMBER,
    url: DPD_PAGE + NUMBER,
    changedAt: "2026-09-29T10:05:00.000Z",
    discoveredAt: "2026-09-29T10:00:00.000Z",
    lastSeenAt: "2026-09-29T10:05:00.000Z",
    trackingEvent: "In Zustellung - 29.09.2026|26.09.,27.09.,29.09.,29.09.,",
    lastWindowTo: "2026-09-29",
    // A manual add is never announced as new; its first reading is the baseline.
    notified: { status: "Out for delivery", delayed: false },
  }]);
  assert.deepEqual(world.transport.lookups, [NUMBER]);
  assert.deepEqual((await world.sourcesFile()).connections, {});
});

// The Status from the page: the delivery status line where it says something
// the ladder can't, else the furthest step reached, else the status picture.
const CASES = [
  { name: "only the handover to DPD", page: { status: "", image: 1, dates: { Start: "28.09." } }, status: "Announced", estimate: null },
  { name: "on the road", page: { status: "Unterwegs", image: 2, dates: { Start: "27.09.", OnTheRoad: "28.09." } }, status: "In transit", estimate: null },
  { name: "at the delivery depot", page: { image: 3, dates: { Start: "27.09.", OnTheRoad: "28.09.", DeliveryDepot: "29.09." } }, status: "In transit", estimate: null },
  {
    name: "in delivery: the status line's day is the Estimate",
    page: { status: "In Zustellung - 29.09.2026", image: 4, dates: { Start: "27.09.", OnTheRoad: "28.09.", DeliveryDepot: "29.09.", CarLoad: "29.09." } },
    status: "Out for delivery", estimate: { from: "2026-09-29", to: "2026-09-29", text: "Tue 29 Sep" },
  },
  {
    name: "delivered: the day it happened",
    page: { status: "Zugestellt - 28.09.2026", image: 5, dates: { Start: "25.09.", CarLoad: "28.09.", Delivered: "28.09." } },
    status: "Delivered", estimate: { from: "2026-09-28", to: "2026-09-28", text: "Delivered Mon 28 Sep" },
  },
  {
    name: "delivered, no status line: the last step's date, in the year of the run",
    page: { image: 5, dates: { Start: "25.09.", Delivered: "28.09." } },
    status: "Delivered", estimate: { from: "2026-09-28", to: "2026-09-28", text: "Delivered Mon 28 Sep" },
  },
  {
    name: "waiting in a Pickup parcelshop",
    page: { status: "Im DPD Pickup Paketshop abholbereit", image: 4, dates: { Start: "26.09.", OnTheRoad: "27.09." } },
    status: "Ready for pickup", estimate: { from: null, to: null, text: "Paketshop" },
  },
  {
    name: "a failed delivery attempt",
    page: { status: "Nicht zugestellt - Empfänger nicht angetroffen", image: 4, dates: { Start: "26.09.", CarLoad: "29.09." } },
    status: "Problem", estimate: { from: null, to: null, text: "Delivery attempt failed" },
  },
  {
    name: "on its way back",
    page: { status: "Rücksendung an den Versender", image: 2, dates: { Start: "26.09.", OnTheRoad: "27.09." } },
    status: "Returning", estimate: null,
  },
  {
    name: "a status line it doesn't know: the steps decide",
    page: { status: "Verzögerung im Paketzentrum", image: 2, dates: { Start: "26.09.", OnTheRoad: "27.09." } },
    status: "In transit", estimate: null,
  },
  { name: "no step dated, only the picture", page: { image: 3 }, status: "In transit", estimate: null },
  { name: "a page that knows nothing yet", page: {}, status: "Unknown", estimate: { from: null, to: null, text: "Not known to DPD yet" } },
];

for (const c of CASES) {
  test(`DPD status: ${c.name} → ${c.status}`, async (t) => {
    const world = await dpdWorld(t, { [NUMBER]: trackingPage(c.page) });
    await world.run("add", NUMBER);
    assert.equal(await world.run("refresh"), 0);
    const s = await world.shipment(`dpd:${NUMBER}`);
    assert.equal(s.status, c.status);
    assert.deepEqual(s.estimate, c.estimate);
  });
}

test("a December step read in January belongs to the year before", async (t) => {
  const world = await dpdWorld(t, { [NUMBER]: trackingPage({ image: 5, dates: { Start: "29.12.", Delivered: "31.12." } }) }, {
    world: { now: "2027-01-02T10:00:00.000Z" },
  });
  await world.run("add", NUMBER);
  await world.run("refresh");
  assert.deepEqual((await world.shipment(`dpd:${NUMBER}`)).estimate, { from: "2026-12-31", to: "2026-12-31", text: "Delivered Thu 31 Dec" });
});

test("a DPD lookup that fails leaves the row as it was and never stops the other lookups", async (t) => {
  const routes = { [NUMBER]: { status: 503, text: "Service Unavailable" }, [OTHER]: changedPage() };
  const dhl = fakeDhl({ [DHL_NUMBER]: { json: { sendungen: [{ id: DHL_NUMBER, sendungNichtGefunden: true, sendungsdetails: { sendungsverlauf: { fortschritt: 0, events: [] } } }] } } });
  const world = await dpdWorld(t, routes, { dhl });
  for (const n of [NUMBER, OTHER, DHL_NUMBER]) await world.run("add", n);

  world.setClock("2026-09-29T10:05:00.000Z");
  assert.equal(await world.run("refresh"), 0);

  for (const n of [NUMBER, OTHER]) {
    const s = await world.shipment(`dpd:${n}`);
    assert.deepEqual([s.status, s.estimate.text, s.lastSeenAt], ["Unknown", "Looking up…", null]);
  }
  assert.equal((await world.shipment(`dhl:${DHL_NUMBER}`)).lastSeenAt, "2026-09-29T10:05:00.000Z");
  assert.match(world.logs.at(-1), /looked up 1 \(1 unknown\), 2 failed$/);
  // No Connection, so no Health: the lookups of manual adds have none.
  assert.deepEqual((await world.sourcesFile()).connections, {});
});

test("a DPD page that lost its session is a failed lookup, not a Status", async (t) => {
  const world = await dpdWorld(t, { [NUMBER]: errorPage() });
  // The tracking page itself answers with DPD's error page.
  await world.run("add", NUMBER);
  await world.run("refresh");
  assert.equal((await world.shipment(`dpd:${NUMBER}`)).lastSeenAt, null);
});

test("offline, DPD lookups that can't connect make the run offline, not failed", async (t) => {
  const world = await dpdWorld(t, { [NUMBER]: { network: true } });
  await world.run("add", NUMBER);
  world.setClock("2026-09-29T10:05:00.000Z");
  assert.equal(await world.run("refresh"), 0);
  const sources = await world.sourcesFile();
  assert.equal(sources.offline, true);
  assert.equal((await world.shipment(`dpd:${NUMBER}`)).lastSeenAt, null);
});

test("a delivered DPD Shipment is not looked up again, and its updates notify like DHL's", async (t) => {
  let page = inTransit();
  const world = await dpdWorld(t, { [NUMBER]: () => page });
  await world.run("add", NUMBER);
  await world.run("refresh");

  page = outForDelivery();
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");
  const [event] = (await world.shipmentsFile()).events;
  assert.deepEqual([event.kind, event.key, event.body.split(" · ")[0]], ["status", `dpd:${NUMBER}`, "DPD"]);

  page = delivered();
  world.setClock("2026-09-29T12:00:00.000Z");
  await world.run("refresh");
  world.setClock("2026-09-29T13:00:00.000Z");
  await world.run("refresh");
  assert.deepEqual(world.transport.lookups, [NUMBER, NUMBER, NUMBER]);
  assert.equal((await world.shipment(`dpd:${NUMBER}`)).status, "Delivered");
});

test("adding a DPD number twice keeps one Shipment, and a 20-digit number is still DHL's", async (t) => {
  const world = await dpdWorld(t, {});
  assert.equal(await world.run("add", NUMBER), 0);
  assert.equal(await world.run("add", NUMBER), 0);
  assert.equal(await world.run("add", DHL_NUMBER), 0);
  assert.deepEqual(world.output, ["Added 1 Shipment", "Already tracked", "Added 1 Shipment"]);
  assert.deepEqual((await world.shipmentsFile()).shipments.map((s) => [s.key, s.source]), [[`dpd:${NUMBER}`, "DPD"], [`dhl:${DHL_NUMBER}`, "DHL"]]);
});

// ---- Amazon via DPD

const ORDER = "321-0000000-0000001";
const ORDER_PAGE = "https://www.amazon.de/your-orders/order-details?orderID=";
const amazonRoutes = ({ carrierLine = "Versendet mit DPD", trackingId = NUMBER } = {}) => ({
  history: historyPage([{ orderId: ORDER, shipments: [{ packageIndex: 0, shipmentId: "T0001", title: "Gießkanne 10 l" }] }]),
  trackers: {
    [`${ORDER}#0`]: trackerPage({
      orderId: ORDER, packageIndex: "0", shortStatus: "IN_TRANSIT", isMfn: true, trackingId,
      promise: { promiseMessage: "Lieferung Donnerstag, 1. Oktober" },
    }, { carrierLine }),
  },
});

async function connectAmazon(world) {
  assert.equal(await world.run("accounts", "add", "Personal", "--accept-risk"), 0);
  assert.equal(await world.run("login", "amazon:Personal"), 0);
}

test("an Amazon Shipment carried by DPD takes DPD's Status and Estimate, keeps its Order link, and reads 'via DPD'", async (t) => {
  let page = outForDelivery();
  const world = await dpdWorld(t, { [NUMBER]: () => page }, { world: { chrome: fakeChrome(amazonRoutes()) } });
  await connectAmazon(world);

  world.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);

  const s = await world.shipment(`amazon:${ORDER}#0`);
  assert.deepEqual([s.source, s.carrier, s.detail, s.url], ["Amazon", "DPD", "DPD", ORDER_PAGE + ORDER]);
  assert.equal(s.status, "Out for delivery");
  assert.deepEqual(s.estimate, { from: "2026-09-29", to: "2026-09-29", text: "Tue 29 Sep" });
  assert.equal(s.title, "Gießkanne 10 l");

  page = delivered();
  world.setClock("2026-09-29T12:00:00.000Z");
  await world.run("refresh");
  const events = (await world.shipmentsFile()).events;
  assert.equal(events.at(-1).key, `amazon:${ORDER}#0`);
  assert.match(events.at(-1).body, /^Amazon · Personal via DPD/);
});

test("Amazon's number format alone names DPD, and a manual add of that number joins the Amazon Shipment", async (t) => {
  const world = await dpdWorld(t, { [NUMBER]: inTransit() }, { world: { chrome: fakeChrome(amazonRoutes({ carrierLine: "" })) } });
  await world.run("add", NUMBER);
  await connectAmazon(world);
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");

  const file = await world.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => s.key), [`amazon:${ORDER}#0`]);
  const [s] = file.shipments;
  assert.equal(s.carrier, "DPD");
  assert.ok(s.connections.includes("manual"));
  assert.equal(s.status, "In transit");
});

test("removing the Amazon account turns its DPD Shipment added by hand back into a DPD Shipment", async (t) => {
  const world = await dpdWorld(t, { [NUMBER]: inTransit() }, { world: { chrome: fakeChrome(amazonRoutes()) } });
  await connectAmazon(world);
  await world.run("add", NUMBER);
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");

  assert.equal(await world.run("accounts", "remove", "Personal"), 0);

  const file = await world.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => [s.key, s.source, s.carrier, s.url, s.status]),
    [[`dpd:${NUMBER}`, "DPD", "DPD", DPD_PAGE + NUMBER, "In transit"]]);
});

// ---- DPD numbers in mail

const shipments = async (world) => (await world.shipmentsFile()).shipments;

async function mailWorld(t, mails, routes) {
  const account = softeriaAccount({ mails });
  const world = await dpdWorld(t, routes, { world: { mail: fakeMail(account.tools) } });
  // Signs the mailbox in with an empty inbox, as the Sources row does.
  const at = world.now.toISOString();
  account.mails = [];
  assert.equal(await world.run("login", "mail"), 0);
  account.mails = mails;
  account.searches.length = 0;
  account.gets.length = 0;
  world.setClock(at);
  return { world, account };
}

test("a DPD Predict mail is a watched DPD Shipment: the shop as its title, its window as the Estimate while DPD gives none", async (t) => {
  let page = inTransit();
  const { world, account } = await mailWorld(t, [dpdPredict({ trackingNumber: NUMBER, at: "2026-09-29T06:00:00Z" })], { [NUMBER]: () => page });

  assert.equal(await world.run("refresh"), 0);

  assert.ok(account.searches.some((s) => s.search === '"DPD"'));
  const s = await world.shipment(`dpd:${NUMBER}`);
  assert.deepEqual([s.source, s.carrier, s.direction, s.url], ["DPD", "DPD", "Incoming", DPD_PAGE + NUMBER]);
  assert.deepEqual(s.connections, ["mail"]);
  assert.equal(s.title, "Beispiel-Shop");
  // DPD's notice names no item: its subject is not one.
  assert.equal(s.itemTitle, undefined);
  assert.equal(s.status, "In transit");
  assert.deepEqual(s.estimate, { from: "2026-09-29T13:31:00", to: "2026-09-29T15:31:00", text: "Tue 29 Sep 13:31–15:31" });
  assert.deepEqual((await world.shipmentsFile()).events, []);
  // Nothing of the mail but the number, the shop and the window.
  assert.ok(!JSON.stringify(await shipments(world)).includes("Guten Tag"));

  // DPD's own day for the delivery is the same day: the window stays.
  page = outForDelivery();
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");
  const out = await world.shipment(`dpd:${NUMBER}`);
  assert.equal(out.status, "Out for delivery");
  assert.equal(out.estimate.text, "Tue 29 Sep 13:31–15:31");

  // A day later the window is past: DPD's word alone.
  page = inTransit();
  world.setClock("2026-09-30T08:00:00.000Z");
  await world.run("refresh");
  assert.equal((await world.shipment(`dpd:${NUMBER}`)).estimate, null);
});

test("a Predict mail for a DPD number already tracked sets its Estimate window, and adds nothing", async (t) => {
  const { world } = await mailWorld(t, [], { [NUMBER]: inTransit() });
  await world.run("add", NUMBER);
  await world.run("refresh");
  assert.equal((await world.shipment(`dpd:${NUMBER}`)).estimate, null);

  world.mail.tools["list-mail-messages"] = () => messageList([dpdPredict({ trackingNumber: NUMBER, at: "2026-09-30T05:30:00Z", from: "9:05", to: "11:05" })]);
  world.setClock("2026-09-30T06:00:00.000Z");
  await world.run("refresh");

  const file = await world.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => [s.key, s.connections]), [[`dpd:${NUMBER}`, ["manual"]]]);
  assert.deepEqual(file.shipments[0].estimate, { from: "2026-09-30T09:05:00", to: "2026-09-30T11:05:00", text: "Wed 30 Sep 09:05–11:05" });
});

test("DPD numbers count in DPD's mails and shop mails naming DPD, not in amazon.de mail or another carrier's", async (t) => {
  const { world } = await mailWorld(t, [
    dpdSoon({ trackingNumber: NUMBER, at: "2026-09-28T08:00:00Z" }),
    dpdShopShipped({ trackingNumber: OTHER, item: "Gartenstuhl Akazie", at: "2026-09-28T09:00:00Z" }),
    amazonDpdNotice({ trackingNumber: "09990000000003", at: "2026-09-28T10:00:00Z" }),
    otherCarrier({ at: "2026-09-28T11:00:00Z" }),
  ], { [NUMBER]: inTransit(), [OTHER]: inTransit() });

  await world.run("refresh");

  const file = await world.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => [s.key, s.source, s.status]).sort(), [
    [`dpd:${NUMBER}`, "DPD", "In transit"],
    [`dpd:${OTHER}`, "DPD", "In transit"],
  ]);
  const shop = file.shipments.find((s) => s.key === `dpd:${OTHER}`);
  assert.deepEqual([shop.itemTitle, shop.itemSource], ["Gartenstuhl Akazie", "subject"]);
  assert.equal(file.shipments.find((s) => s.key === `dpd:${NUMBER}`).estimate, null);
});
