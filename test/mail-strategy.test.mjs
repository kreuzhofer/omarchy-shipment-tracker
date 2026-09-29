// Mail discovers and enriches, never decides a Status (#59, revising #10 and
// #34), at the one seam: the CLI with a fake MCP transport answering as
// Softeria does, fake DHL lookups and a fake Chrome. Every mail, number,
// Order ID and item is synthetic; see fixtures/mail/softeria.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeChrome, fakeDhl, fakeDhlAccount, fakeMail, fixture, makeWorld } from "./harness.mjs";
import { historyPage, trackerPage } from "./fixtures/amazon/pages.mjs";
import {
  delivered, graphError, marketplaceShipped, noAccount, newsletter, orderConfirmation, otherCarrier, outForDelivery, shippingConfirmation, shopShipped, softeriaAccount,
} from "./fixtures/mail/softeria.mjs";

const EBAY_NUMBER = "00340434000000000501";
const SHOP_NUMBER = "00340434000000000502";
const KNOWN_NUMBER = "00340434000000000033"; // in-transit.json's own number
const ORDER_A = "305-5555555-5555555";
const ORDER_OLD = "306-6666666-6666666";
const DHL_PAGE = "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=";

// DHL's anonymous lookup answering with a recorded element, renumbered.
function dhlElement(name, number) {
  const recorded = fixture(`dhl/${name}.json`);
  return { json: JSON.parse(JSON.stringify(recorded).replaceAll(recorded.sendungen[0].id, number)) };
}

async function mailWorld(t, account, worldOptions = {}) {
  const world = await makeWorld({ mail: fakeMail(account.tools), ...worldOptions });
  t.after(() => world.cleanup());
  return world;
}

// Signs the mailbox in with an empty inbox, as the Sources row does.
async function connectMail(world, account) {
  const mails = account.mails;
  const at = world.now.toISOString();
  account.mails = [];
  assert.equal(await world.run("login", "mail"), 0);
  account.mails = mails;
  account.searches.length = 0;
  account.gets.length = 0;
  world.mail.calls.length = 0;
  world.setClock(at);
}

const shipments = async (world) => (await world.shipmentsFile()).shipments;
const keys = async (world) => (await shipments(world)).map((s) => s.key).sort();

// ---- 1. Mail finds new DHL numbers

test("a DHL number in a marketplace's shipping mail becomes a watched Shipment: Status from the lookup, the item from the mail, no 'new'", async (t) => {
  const item = "Vintage Kamera & Tasche";
  const account = softeriaAccount({ mails: [marketplaceShipped({ trackingNumber: EBAY_NUMBER, item, at: "2026-09-28T16:00:00Z" })] });
  let answer = dhlElement("in-transit", EBAY_NUMBER);
  const world = await mailWorld(t, account, { transport: fakeDhl({ [EBAY_NUMBER]: () => answer }) });
  await connectMail(world, account);

  assert.equal(await world.run("refresh"), 0);

  const s = await world.shipment(`dhl:${EBAY_NUMBER}`);
  assert.equal(s.source, "DHL");
  assert.equal(s.carrier, "DHL");
  assert.equal(s.direction, "Incoming");
  assert.deepEqual(s.connections, ["mail"]);
  assert.equal(s.status, "In transit");
  assert.equal(s.url, DHL_PAGE + EBAY_NUMBER);
  assert.equal(s.lastSeenAt, "2026-09-29T10:00:00.000Z");
  // The seller's listing link names the item (per-sender parser, on the HTML).
  assert.equal(s.itemTitle, item);
  assert.equal(s.itemSource, "parser");
  // Only extracted fields are kept: nothing of the mail's body.
  assert.ok(!JSON.stringify(s).includes("Gute Nachrichten"));
  assert.ok(!readFileSync(join(world.stateDir, "shipments.json"), "utf8").includes("beispiel_verkauf"));
  // The HTML came from a second, HTML-bodied session, for this mail only.
  assert.equal(world.mail.starts.at(-1).env.MS365_MCP_BODY_FORMAT, "html");
  assert.deepEqual(account.gets.map((g) => g["message-id"]), [account.mails[0].id]);
  assert.deepEqual((await world.shipmentsFile()).events, []);

  // From then on it is watched like a manual add: DHL's updates notify.
  answer = dhlElement("out-for-delivery", EBAY_NUMBER);
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");
  // The notification names the item the mail gave (#67's wording).
  const [event] = (await world.shipmentsFile()).events;
  assert.deepEqual([event.kind, event.key, event.title], ["status", `dhl:${EBAY_NUMBER}`, `Your ${item} is out for delivery`]);
  assert.match(event.body, /^DHL( · |$)/);
  // The mail is still there: nothing more is fetched for a known number.
  assert.equal(account.gets.length, 1);
  assert.deepEqual(await keys(world), [`dhl:${EBAY_NUMBER}`]);
});

test("a number already tracked isn't added twice: by hand, from DHL's list, or found in mail before", async (t) => {
  const account = softeriaAccount({
    mails: [
      shopShipped({ trackingNumber: KNOWN_NUMBER, item: "Bambus-Schneidebrett", at: "2026-09-28T08:00:00Z" }),
      marketplaceShipped({ trackingNumber: EBAY_NUMBER, item: "Vintage Kamera", at: "2026-09-28T09:00:00Z" }),
    ],
  });
  const dhl = fakeDhlAccount({
    inbox: { json: fixture("dhl/in-transit.json") }, enrich: { json: fixture("dhl/in-transit.json") },
    anonymous: { [EBAY_NUMBER]: dhlElement("in-transit", EBAY_NUMBER) },
  });
  const world = await mailWorld(t, account, { transport: dhl });
  await world.run("login", "dhl");
  await world.run("add", EBAY_NUMBER);
  await connectMail(world, account);

  await world.run("refresh");
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");

  assert.deepEqual(await keys(world), [`dhl:${KNOWN_NUMBER}`, `dhl:${EBAY_NUMBER}`]);
  // Each stays as its Connections know it; no item info is fetched for them.
  assert.deepEqual((await world.shipment(`dhl:${KNOWN_NUMBER}`)).connections, ["dhl"]);
  assert.deepEqual((await world.shipment(`dhl:${EBAY_NUMBER}`)).connections, ["manual"]);
  assert.equal(account.gets.length, 0);
});

test("the item ladder: schema.org markup first; the subject when the HTML can't be had; nothing from a subject that names no item", async (t) => {
  const numbers = ["00340434000000000601", "00340434000000000602", "00340434000000000603"];
  const account = softeriaAccount({
    mails: [
      shopShipped({ trackingNumber: numbers[0], item: "Bambus-Schneidebrett, 3-teilig", at: "2026-09-28T08:00:00Z" }),
      // Markup for another parcel: not this number's item.
      shopShipped({ trackingNumber: numbers[1], schemaNumber: "00340434000000000999", item: "Falsches Teil", at: "2026-09-28T09:00:00Z" }),
      marketplaceShipped({ trackingNumber: numbers[2], item: "Wanderschuhe Gr. 43", at: "2026-09-28T10:00:00Z" }),
    ],
  });
  const routes = Object.fromEntries(numbers.map((n) => [n, dhlElement("in-transit", n)]));
  const world = await mailWorld(t, account, { transport: fakeDhl(routes) });
  await connectMail(world, account);
  // Graph won't hand out the marketplace mail's HTML.
  account.get = (args) => (args["message-id"] === account.mails[2].id ? graphError(404, "Not Found") : null);

  await world.run("refresh");

  const item = async (n) => {
    const s = await world.shipment(`dhl:${n}`);
    return [s.status, s.itemTitle ?? null, s.itemSource ?? null];
  };
  assert.deepEqual(await item(numbers[0]), ["In transit", "Bambus-Schneidebrett, 3-teilig", "schema"]);
  assert.deepEqual(await item(numbers[1]), ["In transit", null, null]);
  assert.deepEqual(await item(numbers[2]), ["In transit", "Wanderschuhe Gr. 43", "subject"]);
  // Losing the HTML costs only the item info: the mailbox is fine.
  assert.equal((await world.sourcesFile()).connections.mail.health, "ok");
  assert.equal((await world.sourcesFile()).connections.mail.failures ?? 0, 0);
});

test("only DHL numbers in recent mail count: not other carriers, not numbers in a newsletter, not mail older than 14 days, not a dropped number", async (t) => {
  const account = softeriaAccount({
    mails: [
      newsletter({ at: "2026-09-28T08:00:00Z" }),
      otherCarrier({ at: "2026-09-28T09:00:00Z" }),
      marketplaceShipped({ trackingNumber: "00340434000000000701", item: "Alter Artikel", at: "2026-09-14T09:00:00Z" }),
      marketplaceShipped({ trackingNumber: "00340434000000000702", item: "Weggeräumt", at: "2026-09-28T09:00:00Z" }),
    ],
  });
  const world = await mailWorld(t, account, { transport: fakeDhl({}) });
  await connectMail(world, account);
  const file = JSON.parse(readFileSync(join(world.stateDir, "shipments.json"), "utf8"));
  file.dropped = [{ key: "dhl:00340434000000000702", at: "2026-09-20T10:00:00.000Z" }];
  writeFileSync(join(world.stateDir, "shipments.json"), JSON.stringify(file));

  assert.equal(await world.run("refresh"), 0);

  assert.deepEqual(await keys(world), []);
  assert.equal(account.gets.length, 0);
});

// ---- 2. Orders only mail knows: a hint, never a Status, never a notification

test("an Order only mail knows shows the last mail's hint, keeps Status Unknown and never notifies", async (t) => {
  const item = "Kaffeebohnen 1 kg";
  const account = softeriaAccount({ mails: [orderConfirmation({ orderId: ORDER_A, item, at: "2026-09-28T08:00:00Z" })] });
  const world = await mailWorld(t, account);
  await connectMail(world, account);
  const seen = [];
  const run = async (at) => {
    world.setClock(at);
    await world.run("refresh");
    const s = await world.shipment(`amazon:${ORDER_A}`);
    const file = await world.shipmentsFile();
    seen.push([s.status, s.hint, s.estimate?.text ?? null, s.delayed, file.events.length]);
  };

  await run("2026-09-29T10:00:00.000Z");
  account.mails.push(shippingConfirmation({ orderId: ORDER_A, item, at: "2026-09-29T11:00:00Z", estimate: "Ankunft übermorgen" }));
  await run("2026-09-29T12:00:00.000Z");
  // A later promise than the one before is not Delayed: mail decides nothing.
  account.mails.push(shippingConfirmation({ orderId: ORDER_A, item, at: "2026-09-30T09:00:00Z", estimate: "Lieferung 5. Oktober" }));
  await run("2026-09-30T10:00:00.000Z");
  account.mails.push(outForDelivery({ orderId: ORDER_A, item, at: "2026-10-05T06:00:00Z" }));
  await run("2026-10-05T07:00:00.000Z");

  assert.deepEqual(seen, [
    ["Unknown", "Ordered · per mail, 28 Sep", "Tue 6 Oct – Thu 8 Oct", false, 0],
    ["Unknown", "Shipped · per mail, 29 Sep", "Thu 1 Oct", false, 0],
    ["Unknown", "Shipped · per mail, 30 Sep", "Mon 5 Oct", false, 0],
    ["Unknown", "Out for delivery · per mail, 5 Oct", "Mon 5 Oct", false, 0],
  ]);
});

test("the hint turns into 'Status unknown' once the mail's estimate is more than 3 days past, until a newer mail", async (t) => {
  const item = "Gartenschlauch 20 m";
  // Shipped on Monday 28 Sep, "Ankunft morgen": Tuesday 29 Sep.
  const account = softeriaAccount({ mails: [shippingConfirmation({ orderId: ORDER_A, item, at: "2026-09-28T09:00:00Z" })] });
  const world = await mailWorld(t, account);
  await connectMail(world, account);
  const hintOn = async (at) => {
    world.setClock(at);
    await world.run("refresh");
    return (await world.shipment(`amazon:${ORDER_A}`)).hint;
  };

  assert.equal(await hintOn("2026-09-29T10:00:00.000Z"), "Shipped · per mail, 28 Sep");
  assert.equal(await hintOn("2026-10-02T21:00:00.000Z"), "Shipped · per mail, 28 Sep");
  assert.equal(await hintOn("2026-10-03T08:00:00.000Z"), "Status unknown");
  const s = await world.shipment(`amazon:${ORDER_A}`);
  assert.equal(s.status, "Unknown");
  assert.equal(s.changedAt, "2026-10-03T08:00:00.000Z");
  assert.deepEqual((await world.shipmentsFile()).events, []);

  // A newer mail brings a new hint.
  account.mails.push(outForDelivery({ orderId: ORDER_A, item, at: "2026-10-04T06:00:00Z" }));
  assert.equal(await hintOn("2026-10-04T07:00:00.000Z"), "Out for delivery · per mail, 4 Oct");
});

test("the hint ages while the mailbox can't be read", async (t) => {
  const account = softeriaAccount({ mails: [shippingConfirmation({ orderId: ORDER_A, item: "Gartenschlauch 20 m", at: "2026-09-28T09:00:00Z" })] });
  const world = await mailWorld(t, account);
  await connectMail(world, account);
  await world.run("refresh");
  account.list = noAccount();

  world.setClock("2026-10-03T08:00:00.000Z");
  await world.run("refresh");

  assert.equal((await world.sourcesFile()).connections.mail.health, "needs-login");
  const s = await world.shipment(`amazon:${ORDER_A}`);
  assert.deepEqual([s.status, s.hint], ["Unknown", "Status unknown"]);
  assert.deepEqual((await world.shipmentsFile()).events.map((e) => e.kind), ["connection"]);
});

test("an Order only mail knows ages out after 30 days like any other Shipment", async (t) => {
  const account = softeriaAccount({ mails: [shippingConfirmation({ orderId: ORDER_A, item: "Notizbuch A5", at: "2026-09-28T09:00:00Z" })] });
  const world = await mailWorld(t, account);
  await connectMail(world, account);
  await world.run("refresh");
  // The hint went stale on 3 Oct; the mail leaves the 30-day window on 28 Oct.
  world.setClock("2026-10-03T08:00:00.000Z");
  await world.run("refresh");

  world.setClock("2026-11-01T09:00:00.000Z");
  await world.run("refresh");
  assert.ok(await world.shipment(`amazon:${ORDER_A}`));
  world.setClock("2026-11-02T09:00:00.000Z");
  await world.run("refresh");
  assert.equal(await world.shipment(`amazon:${ORDER_A}`), undefined);
  assert.deepEqual((await world.shipmentsFile()).dropped.map((d) => d.key), [`amazon:${ORDER_A}`]);
});

// ---- 3. Accounts connected later take over

const itemTitle = "Winterstiefel Gr. 42";
const olderHistory = historyPage([{ orderId: "307-7777777-7777777", shipments: [{ packageIndex: 0, shipmentId: "Tbbbbbbbb", title: "Etwas Neueres" }] }]);
const foundBySearch = historyPage([{ orderId: ORDER_OLD, shipments: [{ packageIndex: 0, shipmentId: "Taaaaaaaa", title: itemTitle }] }]);
const deliveredTracker = trackerPage({
  orderId: ORDER_OLD, packageIndex: "0", shortStatus: "DELIVERED",
  progressTracker: { lastTransitionPercentComplete: 100, lastReachedMilestone: "DELIVERED", numberOfReachedMilestones: 4 },
  promise: { promiseMessage: "Zugestellt am 22. September" },
}, { carrierLine: "Versand durch Amazon" });

test("an account connected later takes over a mail row through the order search, beyond history page 1, without a notification", async (t) => {
  // Shipped 20 Sep, "Ankunft morgen": stale by now. The live bug: this row
  // read "In transit" long after the Order was delivered.
  const account = softeriaAccount({ mails: [shippingConfirmation({ orderId: ORDER_OLD, item: "Winterstiefel", at: "2026-09-20T09:00:00Z" })] });
  const chrome = fakeChrome({
    accounts: {
      Business: {
        history: olderHistory,
        trackers: { [`${ORDER_OLD}#0`]: deliveredTracker, "307-7777777-7777777#0": trackerPage({ orderId: "307-7777777-7777777" }) },
        search: { [ORDER_OLD]: foundBySearch },
      },
    },
  });
  const world = await mailWorld(t, account, { chrome });
  await connectMail(world, account);
  await world.run("refresh");
  const row = await world.shipment(`amazon:${ORDER_OLD}`);
  assert.deepEqual([row.status, row.hint], ["Unknown", "Status unknown"]);

  // Connecting the Business account: its first sync finds the Order.
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("accounts", "add", "Business", "--accept-risk");
  assert.equal(await world.run("login", "amazon:Business"), 0);

  const searched = world.chrome.navigations.filter((n) => new URL(n.url).pathname.startsWith("/your-orders/search"));
  assert.equal(searched.length, 1);
  assert.deepEqual(await keys(world), [`amazon:${ORDER_OLD}#0`, "amazon:307-7777777-7777777#0"]);
  const taken = await world.shipment(`amazon:${ORDER_OLD}#0`);
  assert.equal(taken.status, "Delivered");
  assert.equal(taken.account, "Business");
  assert.deepEqual(taken.connections, ["amazon:Business"]);
  assert.equal(taken.title, itemTitle);
  assert.equal(taken.discoveredAt, "2026-09-29T10:00:00.000Z");
  assert.equal(taken.hint, undefined);
  assert.deepEqual((await world.shipmentsFile()).events, []);

  // Mail still names the Order: the account's Shipment stands for it.
  world.setClock("2026-09-29T12:00:00.000Z");
  await world.run("refresh");
  assert.deepEqual(await keys(world), [`amazon:${ORDER_OLD}#0`, "amazon:307-7777777-7777777#0"]);
  assert.deepEqual((await world.shipmentsFile()).events, []);
});

test("every account looks for a mail row once; the one that owns it takes over, still Terminal-aware and within the page cap", async (t) => {
  const account = softeriaAccount({ mails: [shippingConfirmation({ orderId: ORDER_OLD, item: "Winterstiefel", at: "2026-09-27T09:00:00Z" })] });
  const inTransit = trackerPage({ orderId: ORDER_OLD, packageIndex: "0", promise: { promiseMessage: "Lieferung Donnerstag, 1. Oktober" } });
  const chrome = fakeChrome({
    accounts: {
      Personal: { history: historyPage([]), trackers: {}, search: { [ORDER_OLD]: historyPage([]) } },
      Business: { history: olderHistory, trackers: { [`${ORDER_OLD}#0`]: inTransit, "307-7777777-7777777#0": trackerPage({ orderId: "307-7777777-7777777" }) }, search: { [ORDER_OLD]: foundBySearch } },
    },
  });
  const world = await mailWorld(t, account, { chrome });
  for (const label of ["Personal", "Business"]) {
    await world.run("accounts", "add", label, "--accept-risk");
    await world.run("login", `amazon:${label}`);
  }
  await connectMail(world, account);
  world.chrome.navigations.length = 0;

  await world.run("refresh");

  const searches = (label) => world.chrome.navigations
    .filter((n) => n.account === label && new URL(n.url).pathname.startsWith("/your-orders/search")).length;
  assert.equal(searches("Personal"), 1);
  assert.equal(searches("Business"), 1);
  const taken = await world.shipment(`amazon:${ORDER_OLD}#0`);
  assert.equal(taken.status, "In transit");
  assert.equal(taken.account, "Business");
  assert.equal(await world.shipment(`amazon:${ORDER_OLD}`), undefined);
  // Mail found it this run: the account's Shipment is the first the user hears of it.
  assert.deepEqual((await world.shipmentsFile()).events.map((e) => [e.kind, e.key]), [["new", `amazon:${ORDER_OLD}#0`]]);

  // Beyond page 1, the owner keeps looking for it until Terminal; Personal doesn't ask again.
  world.chrome.navigations.length = 0;
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");
  assert.equal(searches("Personal"), 0);
  assert.equal(searches("Business"), 1);
});

// ---- 4. Migration of rows from before #59

test("rows mail wrote before #59 lose their mail Status quietly and keep their data; a dismissed one stays dismissed", async (t) => {
  const account = softeriaAccount();
  const world = await mailWorld(t, account);
  await connectMail(world, account);
  const legacy = (orderId, fields) => ({
    key: `amazon:${orderId}`, direction: "Incoming", source: "Amazon", account: null, carrier: null, connections: ["mail"],
    title: "Altes Teil", delayed: false, orderId, url: `https://www.amazon.de/your-orders/order-details?orderID=${orderId}`,
    discoveredAt: "2026-09-20T10:00:00.000Z", changedAt: "2026-09-21T10:00:00.000Z", lastSeenAt: "2026-09-29T09:00:00.000Z",
    ...fields,
  });
  const file = JSON.parse(readFileSync(join(world.stateDir, "shipments.json"), "utf8"));
  file.shipments = [
    legacy("311-1111111-1111111", {
      status: "In transit", estimate: { from: "2026-09-22", to: "2026-09-22", text: "Ankunft morgen" }, lastWindowTo: "2026-09-23",
      delayed: true, notified: { status: "In transit", delayed: true },
    }),
    legacy("312-2222222-2222222", {
      status: "Delivered", estimate: { from: "2026-09-25", to: "2026-09-25", text: "Delivered Fri 25 Sep" }, terminalAt: "2026-09-25T12:00:00.000Z",
      notified: { status: "Delivered", delayed: false },
    }),
    legacy("313-3333333-3333333", {
      status: "Announced", estimate: { from: "2026-10-06", to: "2026-10-08", text: "Lieferung 6. – 8. Oktober" },
      notified: { status: "Announced", delayed: false },
      dismissedAt: "2026-09-28T10:00:00.000Z", dismissedAs: { status: "Announced", estimate: "2026-10-06/2026-10-08", delayed: false, trackingEvent: null },
    }),
  ];
  writeFileSync(join(world.stateDir, "shipments.json"), JSON.stringify(file));

  assert.equal(await world.run("refresh"), 0);

  const byKey = Object.fromEntries((await shipments(world)).map((s) => [s.key, s]));
  const view = (s) => ({ status: s.status, hint: s.hint, estimate: s.estimate, delayed: s.delayed, changedAt: s.changedAt, dismissed: Boolean(s.dismissedAt) });
  assert.deepEqual(view(byKey["amazon:311-1111111-1111111"]), {
    status: "Unknown", hint: "Status unknown", estimate: { from: "2026-09-22", to: "2026-09-22", text: "Tue 22 Sep" },
    delayed: false, changedAt: "2026-09-21T10:00:00.000Z", dismissed: false,
  });
  assert.deepEqual(view(byKey["amazon:312-2222222-2222222"]), {
    status: "Unknown", hint: "Delivered · per mail, 29 Sep", estimate: null, delayed: false, changedAt: "2026-09-21T10:00:00.000Z", dismissed: false,
  });
  assert.deepEqual(view(byKey["amazon:313-3333333-3333333"]), {
    status: "Unknown", hint: "Ordered · per mail, 29 Sep", estimate: { from: "2026-10-06", to: "2026-10-08", text: "Tue 6 Oct – Thu 8 Oct" },
    delayed: false, changedAt: "2026-09-21T10:00:00.000Z", dismissed: true,
  });
  for (const s of Object.values(byKey)) {
    assert.equal(s.lastWindowTo, undefined);
    assert.equal(s.terminalAt, undefined);
    assert.deepEqual(s.probedBy, []);
  }
  assert.deepEqual((await world.shipmentsFile()).events, []);
});

test("a Terminal row mail wrote before #59 whose mail is still in the window turns Unknown with the hint, and a half-migrated one is fixed, quietly", async (t) => {
  // The live bug: the mailbox still names both Orders, so the run's mail
  // reading came before the migration and the Delivered Status stayed.
  const ORDER_B = "314-4444444-4444444";
  const ORDER_C = "315-5555555-5555555";
  const account = softeriaAccount({
    mails: [
      delivered({ orderId: ORDER_B, item: "Lampenschirm", at: "2026-09-25T12:00:00Z" }),
      delivered({ orderId: ORDER_C, item: "Teekanne", at: "2026-09-26T12:00:00Z" }),
    ],
  });
  const world = await mailWorld(t, account);
  await connectMail(world, account);
  const row = (orderId, fields) => ({
    key: `amazon:${orderId}`, direction: "Incoming", source: "Amazon", account: null, carrier: null, connections: ["mail"],
    title: "Altes Teil", delayed: false, orderId, url: `https://www.amazon.de/your-orders/order-details?orderID=${orderId}`,
    discoveredAt: "2026-09-20T10:00:00.000Z", changedAt: "2026-09-25T12:00:00.000Z", lastSeenAt: "2026-09-29T09:00:00.000Z",
    status: "Delivered", estimate: { from: "2026-09-25", to: "2026-09-25", text: "Delivered Fri 25 Sep" }, terminalAt: "2026-09-25T12:00:00.000Z",
    notified: { status: "Delivered", delayed: false },
    ...fields,
  });
  const file = JSON.parse(readFileSync(join(world.stateDir, "shipments.json"), "utf8"));
  file.shipments = [
    // Pre-#59 shape.
    row(ORDER_B, { dismissedAt: "2026-09-26T10:00:00.000Z", dismissedAs: { status: "Delivered", estimate: "2026-09-25/2026-09-25", delayed: false, trackingEvent: null } }),
    // What #65's first runs left: the hint, but still a Status.
    row(ORDER_C, {
      mail: { step: "Delivered", at: "2026-09-26T12:00:00.000Z", estimate: null }, hint: "Delivered · per mail, 26 Sep",
      estimate: null, probedBy: [], trackingEvent: "mail@2026-09-26T12:00:00.000Z",
    }),
  ];
  writeFileSync(join(world.stateDir, "shipments.json"), JSON.stringify(file));

  assert.equal(await world.run("refresh"), 0);

  const view = (s) => ({ status: s.status, hint: s.hint, estimate: s.estimate, terminalAt: s.terminalAt, notified: s.notified, dismissed: Boolean(s.dismissedAt) });
  assert.deepEqual(view(await world.shipment(`amazon:${ORDER_B}`)), {
    status: "Unknown", hint: "Delivered · per mail, 25 Sep", estimate: null, terminalAt: undefined, notified: { status: "Unknown", delayed: false }, dismissed: true,
  });
  assert.deepEqual(view(await world.shipment(`amazon:${ORDER_C}`)), {
    status: "Unknown", hint: "Delivered · per mail, 26 Sep", estimate: null, terminalAt: undefined, notified: { status: "Unknown", delayed: false }, dismissed: false,
  });
  assert.deepEqual((await world.shipmentsFile()).events, []);

  // No longer Terminal: they go 30 days after their last change once the
  // mail has left the window, like any other row mail knows.
  account.mails = [];
  world.setClock("2026-10-25T11:00:00.000Z");
  await world.run("refresh");
  assert.ok(await world.shipment(`amazon:${ORDER_B}`));
  world.setClock("2026-10-26T13:00:00.000Z");
  await world.run("refresh");
  assert.deepEqual(await keys(world), []);
  assert.deepEqual((await world.shipmentsFile()).events, []);
});

// ---- 5. Item info for DHL Shipments already listed (#70, the #54 plan)

const searchesFor = (account, number) => account.searches.filter((s) => s.search === `"${number}"`).length;

test("a parcel DHL's list already shows gets its item from the mailbox: one search for its number, the ladder, never a Status", async (t) => {
  const item = "Retro Plattenspieler";
  const account = softeriaAccount({
    mails: [
      // Older than the 14-day window of the DHL search: only the search for
      // the number finds it.
      marketplaceShipped({ trackingNumber: KNOWN_NUMBER, item, at: "2026-09-10T16:00:00Z" }),
      // Graph's $search is fuzzy: a hit without the number verbatim is ignored.
      marketplaceShipped({ trackingNumber: "00340434000000000999", item: "Etwas anderes", at: "2026-09-12T16:00:00Z" }),
    ],
  });
  const dhl = fakeDhlAccount({ inbox: { json: fixture("dhl/in-transit.json") }, enrich: { json: fixture("dhl/in-transit.json") } });
  const world = await mailWorld(t, account, { transport: dhl });
  await connectMail(world, account);
  await world.run("login", "dhl");
  const before = await world.shipment(`dhl:${KNOWN_NUMBER}`);
  assert.equal(before.itemTitle, undefined);

  assert.equal(await world.run("refresh"), 0);

  const s = await world.shipment(`dhl:${KNOWN_NUMBER}`);
  assert.deepEqual([s.itemTitle, s.itemSource], [item, "parser"]);
  assert.equal(s.mailSearchedAt, "2026-09-29T10:00:00.000Z");
  // Nothing else of the row changes, and nothing is announced.
  for (const field of ["status", "estimate", "delayed", "changedAt", "connections", "title", "notified"]) {
    assert.deepEqual(s[field], before[field], field);
  }
  assert.deepEqual((await world.shipmentsFile()).events, []);
  assert.equal(searchesFor(account, KNOWN_NUMBER), 1);
  assert.deepEqual(account.gets.map((g) => g["message-id"]), [account.mails[0].id]);
  assert.ok(!readFileSync(join(world.stateDir, "shipments.json"), "utf8").includes("beispiel_verkauf"));

  // Never searched again.
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");
  assert.equal(searchesFor(account, KNOWN_NUMBER), 1);
  assert.equal(account.gets.length, 1);
  assert.equal((await world.shipment(`dhl:${KNOWN_NUMBER}`)).itemTitle, item);
});

test("at most 5 searches per run, each Shipment once, also when no mail names it", async (t) => {
  const numbers = Array.from({ length: 7 }, (_, i) => `0034043400000000071${i}`);
  const account = softeriaAccount({
    // No mail for the last number.
    mails: numbers.slice(0, 6).map((n, i) => marketplaceShipped({ trackingNumber: n, item: `Teil Nummer ${i + 1}`, at: "2026-09-01T10:00:00Z" })),
  });
  const routes = Object.fromEntries(numbers.map((n) => [n, dhlElement("in-transit", n)]));
  const world = await mailWorld(t, account, { transport: fakeDhl(routes) });
  await connectMail(world, account);
  for (const n of numbers) await world.run("add", n);

  const searched = () => numbers.filter((n) => searchesFor(account, n) > 0).length;
  await world.run("refresh");
  assert.equal(searched(), 5);
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");
  assert.equal(searched(), 7);
  world.setClock("2026-09-29T12:00:00.000Z");
  await world.run("refresh");
  assert.ok(numbers.every((n) => searchesFor(account, n) === 1));

  const list = await shipments(world);
  assert.deepEqual(list.map((s) => s.itemTitle ?? null).sort(), [...numbers.slice(0, 6).map((_, i) => `Teil Nummer ${i + 1}`), null].sort());
  assert.ok(list.every((s) => s.mailSearchedAt && s.status === "In transit"));
  assert.deepEqual((await world.shipmentsFile()).events, []);
});

test("a Terminal Shipment is searched only when it turned Terminal in the last 7 days; one with an item or found in mail isn't searched", async (t) => {
  const [RECENT, OLD, NAMED] = ["00340434000000000801", "00340434000000000802", "00340434000000000803"];
  const account = softeriaAccount({
    mails: [
      marketplaceShipped({ trackingNumber: RECENT, item: "Kürzlich geliefert", at: "2026-09-20T10:00:00Z" }),
      marketplaceShipped({ trackingNumber: OLD, item: "Längst geliefert", at: "2026-09-15T10:00:00Z" }),
      marketplaceShipped({ trackingNumber: NAMED, item: "Schon benannt", at: "2026-09-15T10:00:00Z" }),
      // A new number in recent mail: its own mail already went through the ladder.
      marketplaceShipped({ trackingNumber: EBAY_NUMBER, item: "Vintage Kamera", at: "2026-09-28T10:00:00Z" }),
    ],
  });
  const world = await mailWorld(t, account, {
    transport: fakeDhl({ [EBAY_NUMBER]: () => dhlElement("in-transit", EBAY_NUMBER), [NAMED]: () => dhlElement("in-transit", NAMED) }),
  });
  await connectMail(world, account);
  const row = (n, fields) => ({
    key: `dhl:${n}`, direction: "Incoming", source: "DHL", account: null, carrier: "DHL", connections: ["manual"], title: n,
    status: "Delivered", estimate: null, delayed: false, trackingNumber: n, url: DHL_PAGE + n,
    discoveredAt: "2026-09-10T10:00:00.000Z", lastSeenAt: "2026-09-29T09:00:00.000Z", notified: { status: "Delivered", delayed: false },
    ...fields,
  });
  const file = JSON.parse(readFileSync(join(world.stateDir, "shipments.json"), "utf8"));
  file.shipments = [
    row(RECENT, { changedAt: "2026-09-27T10:00:00.000Z", terminalAt: "2026-09-27T10:00:00.000Z" }),
    row(OLD, { changedAt: "2026-09-21T10:00:00.000Z", terminalAt: "2026-09-21T10:00:00.000Z" }),
    row(NAMED, { status: "In transit", notified: { status: "In transit", delayed: false }, changedAt: "2026-09-27T10:00:00.000Z", itemTitle: "Von Hand", itemSource: "subject" }),
  ];
  writeFileSync(join(world.stateDir, "shipments.json"), JSON.stringify(file));

  await world.run("refresh");

  assert.deepEqual([RECENT, OLD, NAMED, EBAY_NUMBER].map((n) => searchesFor(account, n)), [1, 0, 0, 0]);
  const item = async (n) => (await world.shipment(`dhl:${n}`)).itemTitle ?? null;
  assert.deepEqual([await item(RECENT), await item(OLD), await item(NAMED), await item(EBAY_NUMBER)],
    ["Kürzlich geliefert", null, "Von Hand", "Vintage Kamera"]);
  assert.equal((await world.shipment(`dhl:${RECENT}`)).status, "Delivered");
  assert.deepEqual((await world.shipmentsFile()).events, []);
});
