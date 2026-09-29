// Several labelled Amazon accounts and manual Amazon Order IDs (#26). All
// Order IDs, tracking numbers and item names are synthetic; see
// fixtures/amazon/pages.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fakeChrome, fakeDhl, fixture, holdLock, makeWorld } from "./harness.mjs";
import { historyPage, trackerPage } from "./fixtures/amazon/pages.mjs";

const ORDER_PAGE = "https://www.amazon.de/your-orders/order-details?orderID=";
const P_ORDER = "401-1111111-1111111";
const B_ORDER = "402-2222222-2222222";
const MANUAL = "403-3333333-3333333";
const OTHER_MANUAL = "404-4444444-4444444";

const order = (orderId, packages = [0], title = "Artikel") => ({
  orderId,
  shipments: packages.map((packageIndex) => ({ packageIndex, shipmentId: `T${packageIndex}`, title: `${title} ${packageIndex}` })),
});
const tracker = (orderId, packageIndex = 0, state = {}) => ({
  [`${orderId}#${packageIndex}`]: trackerPage({ orderId, packageIndex: String(packageIndex), ...state }),
});
// The order search answers with the history's markup: the matching Order, or none.
const noMatch = historyPage([]);

// DHL's anonymous lookup (#27) of a DHL number an Amazon package carries,
// answering that DHL doesn't know it yet: Amazon's reading stays.
const PACKAGE_NUMBER = "00340434000000000303";
function dhlDoesntKnow(number) {
  const recorded = fixture("dhl/unknown.json");
  const json = JSON.parse(JSON.stringify(recorded).replaceAll(recorded.sendungen[0].id, number));
  return fakeDhl({ [number]: { json } });
}

function accountsRoutes() {
  return {
    accounts: {
      Personal: { history: historyPage([order(P_ORDER, [0], "Buch")]), trackers: tracker(P_ORDER), search: {} },
      Business: { history: historyPage([order(B_ORDER, [0], "Toner")]), trackers: tracker(B_ORDER), search: {} },
    },
  };
}

async function world2(t, routes = accountsRoutes(), transport = undefined) {
  const world = await makeWorld({ chrome: fakeChrome(routes), transport });
  t.after(() => world.cleanup());
  return world;
}

async function connect(world, ...labels) {
  for (const label of labels) {
    assert.equal(await world.run("accounts", "add", label, "--accept-risk"), 0);
    assert.equal(await world.run("login", `amazon:${label}`), 0);
  }
  world.chrome.launches.length = 0;
  world.chrome.navigations.length = 0;
  world.chrome.reads.length = 0;
}

const searches = (world) => world.chrome.navigations
  .filter((n) => new URL(n.url).pathname.startsWith("/your-orders/search"))
  .map((n) => `${n.account}:${new URL(n.url).searchParams.get("search")}`);

test("account labels are required and unique", async (t) => {
  const world = await world2(t);

  assert.equal(await world.run("accounts", "add"), 2);
  assert.equal(await world.run("accounts", "add", "--accept-risk"), 2);
  assert.equal(await world.run("accounts", "add", "Personal", "--accept-risk"), 0);
  assert.equal(await world.run("accounts", "add", "PERSONAL", "--accept-risk"), 2);

  assert.deepEqual(Object.keys((await world.sourcesFile()).connections), ["amazon:Personal"]);
});

test("two accounts are read one after another, each in its own profile, and rows carry the account's label", async (t) => {
  const world = await world2(t);
  await connect(world, "Personal", "Business");
  world.setClock("2026-09-29T11:00:00.000Z");

  assert.equal(await world.run("refresh"), 0);

  assert.deepEqual(world.chrome.launches.map((l) => [l.port, l.args[0]]), [
    [9350, `--user-data-dir=${join(world.dataDir, "amazon/Personal")}`],
    [9351, `--user-data-dir=${join(world.dataDir, "amazon/Business")}`],
  ]);
  assert.equal(world.chrome.overlapped, false);
  const rows = (await world.shipmentsFile()).shipments.map((s) => [s.key, s.account, s.connections]);
  assert.deepEqual(rows, [
    [`amazon:${P_ORDER}#0`, "Personal", ["amazon:Personal"]],
    [`amazon:${B_ORDER}#0`, "Business", ["amazon:Business"]],
  ]);
  const { connections } = await world.sourcesFile();
  assert.equal(connections["amazon:Personal"].health, "ok");
  assert.equal(connections["amazon:Business"].health, "ok");
});

test("a refresh skips an account whose profile is locked, as neither success nor failure", async (t) => {
  const world = await world2(t);
  await connect(world, "Personal", "Business");
  const before = (await world.sourcesFile()).connections["amazon:Personal"];
  const release = await holdLock(join(world.dataDir, "amazon/Personal"));
  t.after(release);
  world.setClock("2026-09-29T11:00:00.000Z");

  assert.equal(await world.run("refresh"), 0);

  assert.deepEqual(world.chrome.launches.map((l) => l.port), [9351]);
  const { connections } = await world.sourcesFile();
  assert.deepEqual(connections["amazon:Personal"], before);
  assert.match(connections["amazon:Business"].lastRun, /^2026-09-29T11:/);
  assert.ok(world.logs.includes("refresh: amazon account busy, skipped"));
});

test("a Login waits for a refresh that holds its profile, then signs in", async (t) => {
  const world = await world2(t);
  assert.equal(await world.run("accounts", "add", "Personal", "--accept-risk"), 0);
  const release = await holdLock(join(world.dataDir, "amazon/Personal"));
  let released = false;
  setTimeout(() => { released = true; release(); }, 300);

  assert.equal(await world.run("login", "amazon:Personal"), 0);

  assert.equal(released, true);
  assert.equal((await world.sourcesFile()).connections["amazon:Personal"].health, "ok");
});

test("the Order ID pattern routes a manual add to Amazon, anything else to DHL", async (t) => {
  const world = await world2(t);

  assert.equal(await world.run("add", ` ${MANUAL} `), 0);
  assert.equal(await world.run("add", "00340434000000000077"), 0);
  assert.equal(await world.run("add", "403-333333-3333333"), 2);

  const [amazon, dhl] = (await world.shipmentsFile()).shipments;
  assert.deepEqual(amazon, {
    key: `amazon:${MANUAL}`,
    direction: "Incoming",
    source: "Amazon",
    account: null,
    carrier: null,
    connections: ["manual"],
    title: MANUAL,
    status: "Unknown",
    estimate: { from: null, to: null, text: "Looking up…" },
    delayed: false,
    orderId: MANUAL,
    url: ORDER_PAGE + MANUAL,
    probedBy: [],
    linkOnly: false,
    changedAt: "2026-09-29T10:00:00.000Z",
    discoveredAt: "2026-09-29T10:00:00.000Z",
    lastSeenAt: null,
  });
  assert.equal(dhl.key, "dhl:00340434000000000077");
  assert.equal(dhl.source, "DHL");
});

test("a manual Order ID is tried in each account's order search until one owns it", async (t) => {
  const routes = accountsRoutes();
  routes.accounts.Personal.search = { [MANUAL]: noMatch };
  routes.accounts.Business.search = { [MANUAL]: historyPage([order(MANUAL, [0, 1], "Drucker")]) };
  routes.accounts.Business.trackers = {
    ...tracker(B_ORDER),
    ...tracker(MANUAL, 0, { shortStatus: "IN_TRANSIT", trackingId: PACKAGE_NUMBER, promise: { promiseMessage: "Lieferung morgen" } }),
    ...tracker(MANUAL, 1, { shortStatus: "ORDERED", progressTracker: { lastReachedMilestone: "ORDERED", numberOfReachedMilestones: 1 } }),
  };
  const world = await world2(t, routes, dhlDoesntKnow(PACKAGE_NUMBER));
  await connect(world, "Personal", "Business");
  await world.run("add", MANUAL);

  assert.equal(await world.run("refresh"), 0);

  assert.deepEqual(searches(world), [`Personal:${MANUAL}`, `Business:${MANUAL}`]);
  const file = await world.shipmentsFile();
  assert.equal(file.shipments.find((s) => s.key === `amazon:${MANUAL}`), undefined);
  const owned = file.shipments.filter((s) => s.orderId === MANUAL)
    .map((s) => [s.key, s.account, s.connections, s.status, s.title, s.url]);
  assert.deepEqual(owned, [
    [`amazon:${MANUAL}#0`, "Business", ["amazon:Business", "manual"], "In transit", "Drucker 0", ORDER_PAGE + MANUAL],
    [`amazon:${MANUAL}#1`, "Business", ["amazon:Business", "manual"], "Announced", "Drucker 1", ORDER_PAGE + MANUAL],
  ]);

  // Personal doesn't own it and isn't asked again; Business finds it again
  // through the search while it isn't in the first page of its history.
  world.chrome.navigations.length = 0;
  await world.run("refresh");
  assert.deepEqual(searches(world), [`Business:${MANUAL}`]);
});

test("an account connected later gets its turn; an Order in its order history is owned without a search", async (t) => {
  const routes = accountsRoutes();
  routes.accounts.Personal.search = { [B_ORDER]: noMatch };
  const world = await world2(t, routes);
  await connect(world, "Personal");
  await world.run("add", B_ORDER);
  await world.run("refresh");
  assert.deepEqual(searches(world), [`Personal:${B_ORDER}`]);
  assert.equal((await world.shipment(`amazon:${B_ORDER}`)).linkOnly, true);
  world.chrome.navigations.length = 0;

  assert.equal(await world.run("accounts", "add", "Business", "--accept-risk"), 0);
  assert.equal(await world.run("login", "amazon:Business"), 0);

  assert.deepEqual(searches(world), []);
  assert.equal(await world.shipment(`amazon:${B_ORDER}`), undefined);
  const s = await world.shipment(`amazon:${B_ORDER}#0`);
  assert.equal(s.account, "Business");
  assert.deepEqual(s.connections, ["amazon:Business", "manual"]);
});

test("adding an Order ID that an account already shows marks its Shipments as added by hand", async (t) => {
  const world = await world2(t);
  await connect(world, "Personal");

  assert.equal(await world.run("add", P_ORDER), 0);

  assert.equal(world.output.at(-1), "Already tracked");
  const file = await world.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => [s.key, s.connections]), [[`amazon:${P_ORDER}#0`, ["amazon:Personal", "manual"]]]);
});

test("with no owning account the row is link-only and still opens the Order page", async (t) => {
  const routes = accountsRoutes();
  routes.accounts.Personal.search = { [MANUAL]: noMatch };
  routes.accounts.Business.search = { [MANUAL]: noMatch };
  const world = await world2(t, routes);
  await connect(world, "Personal", "Business");
  await world.run("add", MANUAL);

  await world.run("refresh");

  const s = await world.shipment(`amazon:${MANUAL}`);
  assert.equal(s.linkOnly, true);
  assert.deepEqual(s.estimate, { from: null, to: null, text: "Link only · no Amazon account" });
  assert.equal(s.url, ORDER_PAGE + MANUAL);
  assert.deepEqual(s.connections, ["manual"]);
  assert.deepEqual(s.probedBy, ["amazon:Personal", "amazon:Business"]);

  // Accounts that don't own it are not asked again.
  world.chrome.navigations.length = 0;
  await world.run("refresh");
  assert.deepEqual(searches(world), []);
});

test("with no Amazon account connected a manual Order ID is link-only after the next refresh", async (t) => {
  const world = await world2(t);
  await world.run("add", MANUAL);
  assert.equal((await world.shipment(`amazon:${MANUAL}`)).estimate.text, "Looking up…");

  await world.run("refresh");

  assert.equal((await world.shipment(`amazon:${MANUAL}`)).estimate.text, "Link only · no Amazon account");
  assert.equal(world.chrome.launches.length, 0);
});

test("ownership searches count against the per-run page cap", async (t) => {
  const orders = Array.from({ length: 8 }, (_, i) => `41${i}-5555555-000000${i}`);
  const world = await world2(t, {
    accounts: {
      Personal: {
        history: historyPage(orders.map((id) => order(id))),
        trackers: Object.assign({}, ...orders.map((id) => tracker(id))),
        search: { [MANUAL]: noMatch, [OTHER_MANUAL]: noMatch },
      },
    },
  });
  await connect(world, "Personal");
  await world.run("add", MANUAL);
  await world.run("add", OTHER_MANUAL);

  await world.run("refresh");

  const navs = world.chrome.navigations.map((n) => new URL(n.url).pathname.split("/").slice(0, 3).join("/"));
  assert.equal(navs.length, 7);
  assert.deepEqual(navs, ["/gp/css", "/your-orders/search", "/your-orders/search",
    "/progress-tracker/package", "/progress-tracker/package", "/progress-tracker/package", "/progress-tracker/package"]);
  for (let i = 1; i < world.chrome.navigations.length; i++) {
    const gap = world.chrome.navigations[i].at - world.chrome.reads[i - 1].at;
    assert.ok(gap >= 4000 && gap <= 12000, `gap ${gap} ms`);
  }
});

test("removing the owning account puts a manual Order ID back to the other accounts, then link-only", async (t) => {
  const routes = accountsRoutes();
  routes.accounts.Personal.search = { [MANUAL]: noMatch };
  routes.accounts.Business.search = { [MANUAL]: historyPage([order(MANUAL, [0, 1])]) };
  routes.accounts.Business.trackers = { ...tracker(B_ORDER), ...tracker(MANUAL, 0), ...tracker(MANUAL, 1) };
  const world = await world2(t, routes);
  await connect(world, "Personal", "Business");
  await world.run("add", MANUAL);
  await world.run("refresh");

  assert.equal(await world.run("accounts", "remove", "Business"), 0);

  const file = await world.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => s.key), [`amazon:${P_ORDER}#0`, `amazon:${MANUAL}`]);
  assert.deepEqual(file.shipments[1].connections, ["manual"]);
  assert.equal(file.shipments[1].account, null);

  // The accounts left are asked again; none owns it.
  world.chrome.navigations.length = 0;
  await world.run("refresh");
  assert.deepEqual(searches(world), [`Personal:${MANUAL}`]);
  const s = await world.shipment(`amazon:${MANUAL}`);
  assert.equal(s.linkOnly, true);
  assert.equal(s.estimate.text, "Link only · no Amazon account");
  assert.equal(s.url, ORDER_PAGE + MANUAL);
});

test("a link-only Order ID can be removed like any manual add", async (t) => {
  const world = await world2(t);
  await world.run("add", MANUAL);

  assert.equal(await world.run("remove", `amazon:${MANUAL}`), 0);

  assert.deepEqual((await world.shipmentsFile()).shipments, []);
});

test("logs never carry the Order IDs that were searched for", async (t) => {
  const routes = accountsRoutes();
  routes.accounts.Personal.search = { [MANUAL]: noMatch };
  routes.accounts.Business.search = { [MANUAL]: noMatch };
  const world = await world2(t, routes);
  await connect(world, "Personal", "Business");
  await world.run("add", MANUAL);
  await world.run("refresh");

  const text = world.logs.join("\n") + JSON.stringify(await world.sourcesFile());
  for (const secret of [MANUAL, P_ORDER, B_ORDER]) assert.ok(!text.includes(secret), secret);
});

// ---- Notifications (#28): an Order added by hand is never `new`, whichever
// account owns it and whatever rows stand for it; its real changes notify once.

const kinds = (events) => events.map((e) => [e.kind, e.key ?? null, e.status ?? null]);
const DELIVERED = {
  shortStatus: "DELIVERED",
  progressTracker: { lastTransitionPercentComplete: 100, lastReachedMilestone: "DELIVERED", numberOfReachedMilestones: 4 },
  promise: { promiseMessage: "Zugestellt: 29. September" },
};

async function refreshAt(world, iso) {
  world.setClock(iso);
  assert.equal(await world.run("refresh"), 0);
  return (await world.shipmentsFile()).events;
}

// Business owns MANUAL (one package, In transit); Personal doesn't.
function ownedByBusiness() {
  const routes = accountsRoutes();
  routes.accounts.Personal.search = { [MANUAL]: noMatch };
  routes.accounts.Business.search = { [MANUAL]: historyPage([order(MANUAL, [0], "Drucker")]) };
  routes.accounts.Business.trackers = { ...tracker(B_ORDER), ...tracker(MANUAL, 0, { shortStatus: "IN_TRANSIT" }) };
  return routes;
}

test("the owning account's package rows replace a manual Order without a new event; a real change notifies once", async (t) => {
  const routes = ownedByBusiness();
  const world = await world2(t, routes);
  await connect(world, "Personal", "Business");
  await world.run("add", MANUAL);

  const events = await refreshAt(world, "2026-09-29T11:00:00.000Z");

  const s = await world.shipment(`amazon:${MANUAL}#0`);
  assert.deepEqual(s.connections, ["amazon:Business", "manual"]);
  assert.equal(await world.shipment(`amazon:${MANUAL}`), undefined);
  assert.deepEqual(events, []);

  routes.accounts.Business.trackers = { ...tracker(B_ORDER), ...tracker(MANUAL, 0, DELIVERED) };
  assert.deepEqual(kinds(await refreshAt(world, "2026-09-29T12:00:00.000Z")), [["status", `amazon:${MANUAL}#0`, "Delivered"]]);
  assert.deepEqual(await refreshAt(world, "2026-09-29T13:00:00.000Z"), []);
});

test("an account that owns a manual Order in its Login's first sync announces nothing, nor does the next refresh", async (t) => {
  const routes = ownedByBusiness();
  const world = await world2(t, routes);
  await connect(world, "Personal");
  await world.run("add", MANUAL);
  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  assert.equal((await world.shipment(`amazon:${MANUAL}`)).linkOnly, true);

  assert.equal(await world.run("accounts", "add", "Business", "--accept-risk"), 0);
  assert.equal(await world.run("login", "amazon:Business"), 0);
  assert.deepEqual((await world.shipmentsFile()).events, []);

  assert.deepEqual((await world.shipment(`amazon:${MANUAL}#0`)).connections, ["amazon:Business", "manual"]);
  assert.deepEqual(await refreshAt(world, "2026-09-29T12:00:00.000Z"), []);
});

test("adding an Order ID an account already shows announces nothing", async (t) => {
  const world = await world2(t);
  await connect(world, "Personal");
  assert.equal(await world.run("add", P_ORDER), 0);

  assert.deepEqual(await refreshAt(world, "2026-09-29T11:00:00.000Z"), []);
});

test("removing the owning account and another account taking the Order over announces nothing", async (t) => {
  const routes = ownedByBusiness();
  const world = await world2(t, routes);
  await connect(world, "Personal", "Business");
  await world.run("add", MANUAL);
  assert.deepEqual(await refreshAt(world, "2026-09-29T11:00:00.000Z"), []);

  assert.equal(await world.run("accounts", "remove", "Business"), 0);
  assert.deepEqual((await world.shipment(`amazon:${MANUAL}`)).connections, ["manual"]);

  // Personal is asked again and now owns it (the Order ID is back to "no
  // account asked yet"), so a package row under Personal replaces it.
  routes.accounts.Personal.search = { [MANUAL]: historyPage([order(MANUAL, [0], "Drucker")]) };
  routes.accounts.Personal.trackers = { ...tracker(P_ORDER), ...tracker(MANUAL, 0, { shortStatus: "IN_TRANSIT" }) };
  const events = await refreshAt(world, "2026-09-29T12:00:00.000Z");

  assert.deepEqual((await world.shipment(`amazon:${MANUAL}#0`)).connections, ["amazon:Personal", "manual"]);
  assert.deepEqual(events, []);
});

test("removing the owning account with no other owner leaves a link-only row and announces nothing", async (t) => {
  const world = await world2(t, ownedByBusiness());
  await connect(world, "Personal", "Business");
  await world.run("add", MANUAL);
  await refreshAt(world, "2026-09-29T11:00:00.000Z");

  assert.equal(await world.run("accounts", "remove", "Business"), 0);
  const events = await refreshAt(world, "2026-09-29T12:00:00.000Z");

  assert.equal((await world.shipment(`amazon:${MANUAL}`)).linkOnly, true);
  assert.deepEqual(events, []);
});

// ---- #43: an Order added by hand never shows twice. An account that said
// no, or never had to be asked, can still list the Order in its history later
// (history lag, an Order placed just after the paste); that is ownership too.

function listsLater(routes, label, orderId, title) {
  const other = label === "Personal" ? P_ORDER : B_ORDER;
  routes.accounts[label].history = historyPage([order(other), order(orderId, [0], title)]);
  routes.accounts[label].trackers = { ...tracker(other), ...tracker(orderId, 0, { shortStatus: "IN_TRANSIT" }) };
}

test("an account that said no and later lists the Order in its history takes it over, without a duplicate or a new event", async (t) => {
  const routes = accountsRoutes();
  routes.accounts.Personal.search = { [MANUAL]: noMatch };
  routes.accounts.Business.search = { [MANUAL]: noMatch };
  const world = await world2(t, routes);
  await connect(world, "Personal", "Business");
  await world.run("add", MANUAL);
  // Business is busy, so only Personal answers: the Order isn't link-only yet.
  const release = await holdLock(join(world.dataDir, "amazon/Business"));
  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  release();
  const before = await world.shipment(`amazon:${MANUAL}`);
  assert.deepEqual(before.probedBy, ["amazon:Personal"]);
  assert.equal(before.linkOnly, false);

  listsLater(routes, "Personal", MANUAL, "Drucker");
  const events = await refreshAt(world, "2026-09-29T12:00:00.000Z");

  const rows = (await world.shipmentsFile()).shipments.filter((s) => s.orderId === MANUAL)
    .map((s) => [s.key, s.account, s.connections]);
  assert.deepEqual(rows, [[`amazon:${MANUAL}#0`, "Personal", ["amazon:Personal", "manual"]]]);
  assert.deepEqual(events, []);
});

test("a link-only Order that later appears in an account's history is taken over the same way", async (t) => {
  const routes = accountsRoutes();
  routes.accounts.Personal.search = { [MANUAL]: noMatch };
  routes.accounts.Business.search = { [MANUAL]: noMatch };
  const world = await world2(t, routes);
  await connect(world, "Personal", "Business");
  await world.run("add", MANUAL);
  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  assert.equal((await world.shipment(`amazon:${MANUAL}`)).linkOnly, true);

  listsLater(routes, "Business", MANUAL, "Drucker");
  world.chrome.navigations.length = 0;
  const events = await refreshAt(world, "2026-09-29T12:00:00.000Z");

  const rows = (await world.shipmentsFile()).shipments.filter((s) => s.orderId === MANUAL)
    .map((s) => [s.key, s.account, s.connections, s.status]);
  assert.deepEqual(rows, [[`amazon:${MANUAL}#0`, "Business", ["amazon:Business", "manual"], "In transit"]]);
  assert.deepEqual(events, []);
  assert.deepEqual(searches(world), []);
});
