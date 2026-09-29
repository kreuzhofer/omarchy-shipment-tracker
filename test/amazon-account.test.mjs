// One Amazon account read through its own hidden Chrome (#25). All Order IDs,
// tracking numbers and item names are synthetic; see fixtures/amazon/pages.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DHL_LOGIN_PORT } from "../plugin/cli/ports.mjs";
import { fakeChrome, fakeDhl, fakeDhlAccount, fixture, makeWorld } from "./harness.mjs";
import {
  captchaPage, cvfPage, historyPage, otpPage, signInPage, trackerPage, trackerPageWithoutState, wafPage,
} from "./fixtures/amazon/pages.mjs";

const DHL_ORDER = "301-1111111-1111111";
const AMZL_ORDER = "302-2222222-2222222";
const NEW_ORDER = "303-3333333-3333333";
const DIGITAL_ORDER = "D01-4444444-4444444";
const DHL_NUMBER = "00340434000000000101";
const AMZL_NUMBER = "DE0000000001";
const ORDER_PAGE = "https://www.amazon.de/your-orders/order-details?orderID=";
const SIGN_IN_URL = "https://www.amazon.de/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.de%2Fyour-orders%2Forders";

const HISTORY = historyPage([
  { orderId: NEW_ORDER, shipments: [{ packageIndex: 0, shipmentId: "Taaaaaaaa", title: "Kabel & Adapter-Set", primary: "Bestellt" }] },
  { orderId: DIGITAL_ORDER, shipments: [{ packageIndex: 0, shipmentId: "Tdddddddd", title: "Ein Hörbuch" }] },
  { orderId: DHL_ORDER, shipments: [{ packageIndex: 0, shipmentId: "Tbbbbbbbb", title: "Gartenschlauch 20 m" }] },
  { orderId: AMZL_ORDER, shipments: [{ packageIndex: 1, shipmentId: "Tcccccccc", title: "Kaffeebohnen 1 kg", primary: "Zugestellt: 28. September" }] },
]);

const TRACKERS = {
  [`${NEW_ORDER}#0`]: trackerPage({
    orderId: NEW_ORDER, packageIndex: "0", shortStatus: "ORDERED",
    progressTracker: { lastTransitionPercentComplete: 0, lastReachedMilestone: "ORDERED", numberOfReachedMilestones: 1 },
    promise: { promiseMessage: "Lieferung 6. – 8. Oktober" },
  }),
  [`${DHL_ORDER}#0`]: trackerPage({
    orderId: DHL_ORDER, packageIndex: "0", shortStatus: "IN_TRANSIT", isMfn: true, trackingId: DHL_NUMBER,
    promise: { promiseMessage: "Lieferung morgen" },
  }, { carrierLine: "Versendet mit DHL" }),
  [`${AMZL_ORDER}#1`]: trackerPage({
    orderId: AMZL_ORDER, packageIndex: "1", shortStatus: "DELIVERED", trackingId: AMZL_NUMBER,
    progressTracker: { lastTransitionPercentComplete: 100, lastReachedMilestone: "DELIVERED", numberOfReachedMilestones: 4 },
    promise: { promiseMessage: "Zugestellt: 28. September" },
  }, { carrierLine: "Versand durch Amazon" }),
};

// The DHL-carried Shipment's number is looked up anonymously on each refresh
// (#27); here DHL doesn't know it yet, so Amazon's own reading stands.
const unknownToDhl = (number) => {
  const recorded = fixture("dhl/unknown.json");
  return { json: JSON.parse(JSON.stringify(recorded).replaceAll(recorded.sendungen[0].id, number)) };
};
const ANONYMOUS = { [DHL_NUMBER]: unknownToDhl(DHL_NUMBER) };

async function amazonWorld(t, routes = { history: HISTORY, trackers: TRACKERS }, options, worldOptions) {
  const chrome = fakeChrome(routes, options);
  const world = await makeWorld({ chrome, transport: fakeDhl(ANONYMOUS), ...worldOptions });
  t.after(() => world.cleanup());
  return world;
}

// An account that has signed in before (Health ok), without running a Login.
async function connectedAccount(world, label = "Personal") {
  assert.equal(await world.run("accounts", "add", label, "--accept-risk"), 0);
  assert.equal(await world.run("login", `amazon:${label}`), 0);
  world.chrome.launches.length = 0;
  world.chrome.navigations.length = 0;
  world.chrome.reads.length = 0;
}

test("accounts add needs --accept-risk and a unique label; it stores no password", async (t) => {
  const world = await amazonWorld(t);

  assert.equal(await world.run("accounts", "add", "Personal"), 2);
  assert.match(world.logs.at(-1), /Conditions of Use.*--accept-risk/);
  assert.equal(await world.run("accounts", "add", "Personal", "--accept-risk"), 0);
  assert.equal(await world.run("accounts", "add", "personal", "--accept-risk"), 2);
  assert.equal(await world.run("accounts", "add", "", "--accept-risk"), 2);
  assert.equal(await world.run("accounts", "add", "Business", "--accept-risk"), 0);

  const { connections } = await world.sourcesFile();
  assert.deepEqual(connections["amazon:Personal"], {
    health: "not-set-up", reason: null, since: "2026-09-29T10:00:00.000Z", lastRun: null, lastOk: null,
    failures: 0, message: null, lastCount: null, login: null, lastLogin: null,
    label: "Personal", riskAcceptedAt: "2026-09-29T10:00:00.000Z", port: 9350,
  });
  assert.equal(connections["amazon:Business"].port, 9351);
  assert.deepEqual(Object.keys(connections), ["amazon:Personal", "amazon:Business"]);
  assert.deepEqual((await readdir(world.stateDir)).filter((f) => f.endsWith(".json")).sort(), ["shipments.json", "sources.json"]);
});

test("a not-set-up account is not read by refresh", async (t) => {
  const world = await amazonWorld(t);
  await world.run("accounts", "add", "Personal", "--accept-risk");

  assert.equal(await world.run("refresh"), 0);

  assert.equal(world.chrome.launches.length, 0);
  assert.equal((await world.sourcesFile()).connections["amazon:Personal"].health, "not-set-up");
});

test("login opens the profile visibly, hides it once the order history loads, and runs the first sync", async (t) => {
  let hiddenWhenHistoryRead = null;
  const world = await amazonWorld(t, {
    // The user needs three polls to sign in.
    history: ({ polls }) => (polls < 3 ? { url: SIGN_IN_URL, html: signInPage() } : HISTORY),
    trackers: new Proxy(TRACKERS, { get: (target, key) => { hiddenWhenHistoryRead ??= world.chrome.hidden; return target[key]; } }),
  });
  await world.run("accounts", "add", "Personal", "--accept-risk");

  assert.equal(await world.run("login", "amazon:Personal"), 0);

  assert.equal(world.chrome.launches.length, 1);
  assert.equal(world.chrome.launches[0].hidden, false);
  assert.equal(hiddenWhenHistoryRead, true);
  assert.equal(world.chrome.open, false);
  const conn = (await world.sourcesFile()).connections["amazon:Personal"];
  assert.equal(conn.health, "ok");
  assert.equal(conn.lastCount, 3);
  assert.ok(await world.exists(join(world.dataDir, "amazon/Personal")));
  assert.deepEqual((await world.shipmentsFile()).shipments.map((s) => s.key).sort(),
    [`amazon:${DHL_ORDER}#0`, `amazon:${AMZL_ORDER}#1`, `amazon:${NEW_ORDER}#0`]);
});

test("login ends as cancelled when the user closes the window, and leaves the account as it was", async (t) => {
  const world = await amazonWorld(t, { history: ({ polls }) => (polls < 2 ? { url: SIGN_IN_URL, html: signInPage() } : { closed: true }) });
  await world.run("accounts", "add", "Personal", "--accept-risk");
  const before = await world.sourcesFile();

  assert.equal(await world.run("login", "amazon:Personal"), 1);

  assert.equal(world.logs.at(-1), "login: Login cancelled");
  assert.deepEqual(await world.sourcesFile(), before);
});

test("login times out after 15 minutes", async (t) => {
  const world = await amazonWorld(t, { history: { url: SIGN_IN_URL, html: signInPage() } });
  await world.run("accounts", "add", "Personal", "--accept-risk");

  assert.equal(await world.run("login", "amazon:Personal"), 1);

  assert.equal(world.logs.at(-1), "login: Login timed out after 15 min");
  assert.equal(world.now.toISOString(), "2026-09-29T10:15:00.000Z");
  assert.equal(world.chrome.open, false);
});

test("Chrome is the installed one: own profile, fixed loopback port, headful and hidden, no automation", async (t) => {
  const world = await amazonWorld(t);
  await connectedAccount(world);

  await world.run("refresh");

  assert.equal(world.chrome.launches.length, 1);
  const { args, port, hidden } = world.chrome.launches[0];
  assert.equal(hidden, true);
  assert.equal(port, 9350);
  assert.deepEqual(args, [
    `--user-data-dir=${join(world.dataDir, "amazon/Personal")}`,
    "--remote-debugging-port=9350",
    "--password-store=gnome-libsecret",
    "--class=ShipmentTrackerChrome",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);
  for (const forbidden of ["--headless", "--enable-automation", "--remote-debugging-pipe", "--remote-debugging-port=0", "--user-agent", "--remote-allow-origins"]) {
    assert.ok(!args.some((a) => a.startsWith(forbidden)), forbidden);
  }
  assert.ok(!world.chrome.methods.some((m) => m.startsWith("Runtime.") || m.startsWith("Emulation.") || m.includes("Script")));
  assert.equal(world.chrome.open, false);
});

test("refresh reads the history, then the tracker pages, into Amazon rows", async (t) => {
  const world = await amazonWorld(t);
  await connectedAccount(world);
  world.setClock("2026-09-29T11:00:00.000Z");

  assert.equal(await world.run("refresh"), 0);

  const file = await world.shipmentsFile();
  const { changedAt, discoveredAt, lastSeenAt, ...dhl } = file.shipments.find((s) => s.key === `amazon:${DHL_ORDER}#0`);
  // Found by the Login's first sync, read again by this run.
  assert.ok(discoveredAt < "2026-09-29T10:15:00.000Z" && changedAt === discoveredAt);
  assert.ok(lastSeenAt > "2026-09-29T11:00:00.000Z");
  assert.deepEqual(dhl, {
    key: `amazon:${DHL_ORDER}#0`,
    direction: "Incoming",
    source: "Amazon",
    account: "Personal",
    carrier: "DHL",
    connections: ["amazon:Personal"],
    title: "Gartenschlauch 20 m",
    status: "In transit",
    estimate: { from: "2026-09-30", to: "2026-09-30", text: "Lieferung morgen" },
    delayed: false,
    lastWindowTo: "2026-09-30",
    orderId: DHL_ORDER,
    url: ORDER_PAGE + DHL_ORDER,
    trackingNumber: DHL_NUMBER,
    notified: { status: "In transit", delayed: false },
  });
  const amzl = file.shipments.find((s) => s.key === `amazon:${AMZL_ORDER}#1`);
  assert.equal(amzl.carrier, "Amazon Logistics");
  assert.equal(amzl.status, "Delivered");
  assert.deepEqual(amzl.estimate, { from: "2026-09-28", to: "2026-09-28", text: "Zugestellt: 28. September" });
  assert.equal(amzl.url, ORDER_PAGE + AMZL_ORDER);
  const fresh = file.shipments.find((s) => s.key === `amazon:${NEW_ORDER}#0`);
  assert.equal(fresh.status, "Announced");
  assert.equal(fresh.carrier, null);
  assert.equal(fresh.trackingNumber, undefined);
  assert.deepEqual(fresh.estimate, { from: "2026-10-06", to: "2026-10-08", text: "Lieferung 6. – 8. Oktober" });
  assert.equal(fresh.title, "Kabel & Adapter-Set");
  assert.ok(!file.shipments.some((s) => s.orderId === DIGITAL_ORDER));
  assert.deepEqual(file.events, []);

  const conn = (await world.sourcesFile()).connections["amazon:Personal"];
  assert.equal(conn.health, "ok");
  assert.equal(conn.lastCount, 3);
  assert.equal(conn.failures, 0);
});

test("Terminal Shipments are never re-fetched", async (t) => {
  const world = await amazonWorld(t);
  await connectedAccount(world);

  await world.run("refresh");

  const trackerVisits = world.chrome.navigations.map((n) => new URL(n.url).searchParams.get("orderId")).filter(Boolean);
  assert.deepEqual(trackerVisits, [NEW_ORDER, DHL_ORDER]);
});

test("a run reads at most 6 tracker pages, with 4–12 s between pages", async (t) => {
  const orders = Array.from({ length: 8 }, (_, i) => `30${i}-5555555-000000${i}`);
  const trackers = Object.fromEntries(orders.map((orderId) => [`${orderId}#0`, trackerPage({ orderId })]));
  const world = await amazonWorld(t, {
    history: historyPage(orders.map((orderId, i) => ({ orderId, shipments: [{ packageIndex: 0, shipmentId: `T${i}`, title: `Artikel ${i}` }] }))),
    trackers,
  });
  // The Login's first sync is capped too.
  await connectedAccount(world);
  assert.equal((await world.shipmentsFile()).shipments.length, 6);

  await world.run("refresh");

  const navs = world.chrome.navigations;
  assert.equal(navs.length, 7);
  assert.match(new URL(navs[0].url).pathname, /^\/gp\/css\/order-history/);
  // From reading one page to navigating to the next.
  for (let i = 1; i < navs.length; i++) {
    const gap = navs[i].at - world.chrome.reads[i - 1].at;
    assert.ok(gap >= 4000 && gap <= 12000, `gap ${gap} ms`);
  }
  // The two not seen yet come first, then the least recently read.
  const visited = navs.slice(1).map((n) => new URL(n.url).searchParams.get("orderId"));
  assert.deepEqual(visited, [orders[6], orders[7], orders[0], orders[1], orders[2], orders[3]]);
  assert.equal((await world.shipmentsFile()).shipments.length, 8);
});

for (const [local, utc, runs] of [
  ["22:59", "2026-09-29T20:59:00.000Z", true],
  ["23:00", "2026-09-29T21:00:00.000Z", false],
  ["03:00", "2026-09-30T01:00:00.000Z", false],
  ["06:59", "2026-09-30T04:59:00.000Z", false],
  ["07:00", "2026-09-30T05:00:00.000Z", true],
]) {
  test(`quiet hours 23:00–07:00: at ${local} Amazon is ${runs ? "read" : "skipped"}`, async (t) => {
    const world = await amazonWorld(t);
    await connectedAccount(world);
    const before = (await world.sourcesFile()).connections["amazon:Personal"];
    world.setClock(utc);

    assert.equal(await world.run("refresh"), 0);

    assert.equal(world.chrome.launches.length, runs ? 1 : 0);
    const after = (await world.sourcesFile()).connections["amazon:Personal"];
    if (!runs) assert.deepEqual(after, before);
    else assert.ok(after.lastRun > utc && after.lastRun < new Date(Date.parse(utc) + 120_000).toISOString());
  });
}

test("a redirect to /ap/signin makes the account needs-login/signed-out and stops its run at once", async (t) => {
  const routes = { history: HISTORY, trackers: TRACKERS };
  const world = await amazonWorld(t, routes);
  await connectedAccount(world);
  const shipments = await world.shipmentsFile();
  routes.history = { url: SIGN_IN_URL, html: signInPage() };
  world.setClock("2026-09-29T11:00:00.000Z");

  assert.equal(await world.run("refresh"), 0);

  assert.equal(world.chrome.navigations.length, 1);
  const conn = (await world.sourcesFile()).connections["amazon:Personal"];
  assert.equal(conn.health, "needs-login");
  assert.equal(conn.reason, "signed-out");
  assert.match(conn.since, /^2026-09-29T11:00:0/);
  assert.equal(conn.message, "Amazon · Personal needs a login");
  assert.deepEqual((await world.shipmentsFile()).shipments, shipments.shipments);

  // A needs-login account is not polled until a Login succeeds.
  world.chrome.launches.length = 0;
  await world.run("refresh");
  assert.equal(world.chrome.launches.length, 0);
});

const CHALLENGES = [
  ["an OTP page", { url: "https://www.amazon.de/ap/mfa?arb=x", html: otpPage() }],
  ["a CVF page", { url: "https://www.amazon.de/ap/cvf/request?arb=x", html: cvfPage() }],
  ["an MFA form on the sign-in path", { url: "https://www.amazon.de/ap/signin", html: otpPage() }],
  ["a captcha", { url: "https://www.amazon.de/errors/validateCaptcha", html: captchaPage() }],
  ["a captcha served at the history URL", captchaPage()],
  ["an AWS WAF challenge", wafPage()],
  ["an ACIC puzzle", { url: "https://www.amazon.de/ax/aaut/verify/ap/challenge?x=1", html: "<html><body><div id=\"aacb-captcha\"></div></body></html>" }],
];

for (const [name, page] of CHALLENGES) {
  test(`${name} makes the account needs-login/challenge`, async (t) => {
    const routes = { history: HISTORY, trackers: TRACKERS };
    const world = await amazonWorld(t, routes);
    await connectedAccount(world);
    routes.history = page;

    await world.run("refresh");

    const conn = (await world.sourcesFile()).connections["amazon:Personal"];
    assert.equal(conn.health, "needs-login");
    assert.equal(conn.reason, "challenge");
    assert.equal(conn.message, "Amazon · Personal asks for a security check");
    assert.equal(world.chrome.navigations.length, 1);
  });
}

test("a challenge on a tracker page stops the run there", async (t) => {
  const routes = { history: HISTORY, trackers: { ...TRACKERS } };
  const world = await amazonWorld(t, routes);
  await connectedAccount(world);
  routes.trackers[`${NEW_ORDER}#0`] = captchaPage();

  await world.run("refresh");

  assert.equal(world.chrome.navigations.length, 2);
  assert.equal((await world.sourcesFile()).connections["amazon:Personal"].reason, "challenge");
});

test("a tracker page without page-state is a shape failure, never an empty list", async (t) => {
  const routes = { history: HISTORY, trackers: { ...TRACKERS } };
  const world = await amazonWorld(t, routes);
  await connectedAccount(world);
  const before = await world.shipmentsFile();
  routes.trackers[`${NEW_ORDER}#0`] = trackerPageWithoutState();

  await world.run("refresh");

  const conn = (await world.sourcesFile()).connections["amazon:Personal"];
  assert.equal(conn.health, "source-down");
  assert.equal(conn.reason, "shape");
  assert.equal(conn.lastCount, 3);
  assert.deepEqual((await world.shipmentsFile()).shipments.map((s) => s.key), before.shipments.map((s) => s.key));
});

test("an order history in an unknown shape is a shape failure", async (t) => {
  const routes = { history: HISTORY, trackers: TRACKERS };
  const world = await amazonWorld(t, routes);
  await connectedAccount(world);
  routes.history = "<html><body><h1>Meine Bestellungen</h1></body></html>";

  await world.run("refresh");

  const conn = (await world.sourcesFile()).connections["amazon:Personal"];
  assert.equal(conn.health, "source-down");
  assert.equal(conn.reason, "shape");
  assert.equal((await world.shipmentsFile()).shipments.length, 3);
});

test("Chrome not coming up counts as a failure; the second one in a row makes it source-down", async (t) => {
  const world = await amazonWorld(t);
  await connectedAccount(world);
  world.chrome = fakeChrome({}, { launchFails: true });

  await world.run("refresh");
  let conn = (await world.sourcesFile()).connections["amazon:Personal"];
  assert.equal(conn.health, "ok");
  assert.equal(conn.failures, 1);

  await world.run("refresh");
  conn = (await world.sourcesFile()).connections["amazon:Personal"];
  assert.equal(conn.health, "source-down");
  assert.equal(conn.reason, "browser");
  assert.equal((await world.shipmentsFile()).shipments.length, 3);
});

test("an account whose Chrome is already open is skipped, neither success nor failure", async (t) => {
  const world = await amazonWorld(t);
  await connectedAccount(world);
  const before = (await world.sourcesFile()).connections["amazon:Personal"];
  world.chrome = fakeChrome({}, { busy: true });
  world.setClock("2026-09-29T11:00:00.000Z");

  await world.run("refresh");

  assert.deepEqual((await world.sourcesFile()).connections["amazon:Personal"], before);
});

test("offline, the account's Health doesn't change and the run is marked offline", async (t) => {
  const routes = { history: HISTORY, trackers: TRACKERS };
  const world = await amazonWorld(t, routes, {}, { transport: fakeDhl({ [DHL_NUMBER]: { network: true } }) });
  await connectedAccount(world);
  routes.history = { error: "net::ERR_INTERNET_DISCONNECTED" };

  await world.run("refresh");
  await world.run("refresh");

  const sources = await world.sourcesFile();
  assert.equal(sources.offline, true);
  assert.equal(sources.connections["amazon:Personal"].health, "ok");
  assert.equal(sources.connections["amazon:Personal"].failures, 0);
});

test("Carrier comes from the page text, else from the tracking number format", async (t) => {
  const orders = ["311-0000000-0000001", "311-0000000-0000002", "311-0000000-0000003", "311-0000000-0000004", "311-0000000-0000005"];
  const world = await amazonWorld(t, {
    history: historyPage(orders.map((orderId) => ({ orderId, shipments: [{ packageIndex: 0, shipmentId: "Tx", title: "x" }] }))),
    trackers: {
      [`${orders[0]}#0`]: trackerPage({ orderId: orders[0], trackingId: "JJD000000000000000001" }),
      [`${orders[1]}#0`]: trackerPage({ orderId: orders[1], trackingId: "00340434000000000202" }),
      [`${orders[2]}#0`]: trackerPage({ orderId: orders[2], trackingId: "DE0000000002" }),
      [`${orders[3]}#0`]: trackerPage({ orderId: orders[3], trackingId: "H0000000000000000003" }, { carrierLine: "Versendet mit Hermes" }),
      [`${orders[4]}#0`]: trackerPage({ orderId: orders[4], trackingId: "00340434000000000205" }, { carrierLine: "Versendet mit Deutsche Post DHL" }),
    },
  });
  await connectedAccount(world);

  const carriers = (await world.shipmentsFile()).shipments.map((s) => [s.orderId, s.carrier]);
  assert.deepEqual(Object.fromEntries(carriers), {
    [orders[0]]: "DHL",
    [orders[1]]: "DHL",
    [orders[2]]: "Amazon Logistics",
    [orders[3]]: "Hermes",
    [orders[4]]: "DHL",
  });
});

// The Amazon column of the spec's Status table. Rows the spec marks "to be
// confirmed" (Ready for pickup, Returning, Returned) have no values yet.
const STATUS_CASES = [
  ["DELIVERED", { shortStatus: "DELIVERED", progressTracker: { lastReachedMilestone: "DELIVERED", numberOfReachedMilestones: 4 } }, "Delivered"],
  ["out for delivery", { shortStatus: "OUT_FOR_DELIVERY", progressTracker: { lastReachedMilestone: "OUT_FOR_DELIVERY", numberOfReachedMilestones: 3 } }, "Out for delivery"],
  ["shipped", { shortStatus: "IN_TRANSIT", progressTracker: { lastReachedMilestone: "SHIPPED", numberOfReachedMilestones: 2 } }, "In transit"],
  ["ordered, not shipped", { shortStatus: "ORDERED", progressTracker: { lastReachedMilestone: "ORDERED", numberOfReachedMilestones: 1 } }, "Announced"],
  ["an exception state", { shortStatus: "IN_TRANSIT", exceptionStateIdentifier: "DELIVERY_ATTEMPTED", progressTracker: { lastReachedMilestone: "SHIPPED", numberOfReachedMilestones: 2 } }, "Problem"],
  ["no milestones", { shortStatus: null, progressTracker: { lastReachedMilestone: null, numberOfReachedMilestones: 0 } }, "Unknown"],
  ["a milestone not seen yet", { shortStatus: "SOMETHING_NEW", progressTracker: { lastReachedMilestone: "SOMETHING_NEW", numberOfReachedMilestones: 2 } }, "Unknown"],
];

for (const [name, state, status] of STATUS_CASES) {
  test(`Amazon Status: ${name} → ${status}`, async (t) => {
    const orderId = "320-0000000-0000001";
    const world = await amazonWorld(t, {
      history: historyPage([{ orderId, shipments: [{ packageIndex: 0, shipmentId: "Tx", title: "x" }] }]),
      trackers: { [`${orderId}#0`]: trackerPage({ orderId, promise: { promiseMessage: "Status text" }, ...state }) },
    });
    await connectedAccount(world);

    const [s] = (await world.shipmentsFile()).shipments;
    assert.equal(s.status, status);
    assert.equal(s.estimate.text, "Status text");
  });
}

test("accounts remove deletes the profile and the account's Shipments", async (t) => {
  const world = await amazonWorld(t);
  await connectedAccount(world);
  await world.run("add", "00340434000000000999");

  assert.equal(await world.run("accounts", "remove", "Personal"), 0);

  assert.equal(await world.exists(join(world.dataDir, "amazon/Personal")), false);
  assert.deepEqual((await world.sourcesFile()).connections, {});
  assert.deepEqual((await world.shipmentsFile()).shipments.map((s) => s.key), ["dhl:00340434000000000999"]);
});

test("logs carry counts and Health only", async (t) => {
  const world = await amazonWorld(t);
  await connectedAccount(world);
  await world.run("refresh");

  const text = world.logs.join("\n") + (await readFile(join(world.stateDir, "sources.json"), "utf8"));
  for (const secret of [DHL_ORDER, AMZL_ORDER, NEW_ORDER, DHL_NUMBER, AMZL_NUMBER, "Gartenschlauch"]) {
    assert.ok(!text.includes(secret), secret);
  }
});

test("a Login fixes needs-login; a first sync that then fails leaves the account connected", async (t) => {
  const routes = { history: { url: SIGN_IN_URL, html: signInPage() }, trackers: TRACKERS };
  const world = await amazonWorld(t, routes);
  await world.run("accounts", "add", "Personal", "--accept-risk");
  routes.history = HISTORY;
  routes.trackers = { [`${NEW_ORDER}#0`]: { error: "net::ERR_CONNECTION_RESET" } };

  assert.equal(await world.run("login", "amazon:Personal"), 1);

  let conn = (await world.sourcesFile()).connections["amazon:Personal"];
  assert.equal(conn.health, "ok");
  assert.equal(conn.failures, 1);

  routes.trackers = TRACKERS;
  await world.run("refresh");
  conn = (await world.sourcesFile()).connections["amazon:Personal"];
  assert.equal(conn.health, "ok");
  assert.equal(conn.failures, 0);
  assert.equal(conn.lastCount, 3);
});

// ---- Together with #23 (Estimate, Delayed, refreshing) and #24 (the DHL
// Connection, its fixed login port, --source).

test("no Amazon account's Chrome ever gets the DHL login window's port", async (t) => {
  const world = await amazonWorld(t);
  const labels = Array.from({ length: 12 }, (_, i) => `Account${i}`);
  for (const label of labels) assert.equal(await world.run("accounts", "add", label, "--accept-risk"), 0);
  await world.run("accounts", "remove", "Account0");
  await world.run("accounts", "add", "Again", "--accept-risk");

  const ports = Object.values((await world.sourcesFile()).connections).map((c) => c.port);
  assert.ok(!ports.includes(DHL_LOGIN_PORT), `DHL login port ${DHL_LOGIN_PORT} in ${ports}`);
  assert.equal(new Set(ports).size, ports.length);
  await world.run("login", "amazon:Again");
  assert.notEqual(world.chrome.launches[0].port, DHL_LOGIN_PORT);
});

test("an Amazon Estimate that moves later marks the Shipment Delayed", async (t) => {
  const trackers = { ...TRACKERS };
  const world = await amazonWorld(t, { history: HISTORY, trackers });
  await connectedAccount(world);
  assert.equal((await world.shipment(`amazon:${NEW_ORDER}#0`)).delayed, false);

  trackers[`${NEW_ORDER}#0`] = trackerPage({
    orderId: NEW_ORDER, packageIndex: "0", shortStatus: "ORDERED",
    progressTracker: { lastTransitionPercentComplete: 0, lastReachedMilestone: "ORDERED", numberOfReachedMilestones: 1 },
    promise: { promiseMessage: "Lieferung 9. – 10. Oktober" },
  });
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");

  const s = await world.shipment(`amazon:${NEW_ORDER}#0`);
  assert.equal(s.delayed, true);
  assert.equal(s.estimate.to, "2026-10-10");
});

test("the run reads DHL first, then Amazon, and stays Refreshing… until Amazon is done", async (t) => {
  const seen = [];
  const history = () => {
    const sources = JSON.parse(readFileSync(join(world.stateDir, "sources.json"), "utf8"));
    seen.push({ dhl: sources.connections.dhl?.lastRun ?? null, refreshing: sources.refreshing });
    return HISTORY;
  };
  const routes = { history: HISTORY, trackers: TRACKERS };
  const dhl = fakeDhlAccount({ inbox: { json: { sendungen: [], rateLimited: false } }, anonymous: ANONYMOUS });
  const world = await amazonWorld(t, routes, {}, { transport: dhl });
  await connectedAccount(world);
  assert.equal(await world.run("login", "dhl"), 0);
  routes.history = history;
  world.setClock("2026-09-29T11:00:00.000Z");

  assert.equal(await world.run("refresh"), 0);

  assert.equal(seen[0].dhl, "2026-09-29T11:00:00.000Z");
  assert.deepEqual(seen[0].refreshing, { startedAt: "2026-09-29T11:00:00.000Z" });
  const sources = await world.sourcesFile();
  assert.equal(sources.refreshing, null);
  assert.equal(sources.connections["amazon:Personal"].health, "ok");
});

test("refresh --source limits the run to that Connection", async (t) => {
  const routes = { history: HISTORY, trackers: TRACKERS };
  const dhl = fakeDhlAccount({ inbox: { json: { sendungen: [], rateLimited: false } }, anonymous: ANONYMOUS });
  const world = await amazonWorld(t, routes, {}, { transport: dhl });
  await connectedAccount(world, "Personal");
  await connectedAccount(world, "Business");
  assert.equal(await world.run("login", "dhl"), 0);
  const tokenCalls = () => dhl.refreshTokens.length;
  const before = tokenCalls();

  assert.equal(await world.run("refresh", "--source", "amazon:Business"), 0);
  assert.equal(world.chrome.launches.length, 1);
  assert.equal(world.chrome.launches[0].args.some((a) => a.endsWith("/amazon/Business")), true);
  assert.equal(tokenCalls(), before);

  world.chrome.launches.length = 0;
  assert.equal(await world.run("refresh", "--source", "dhl"), 0);
  assert.equal(world.chrome.launches.length, 0);
  assert.equal(tokenCalls(), before + 1);
});

test("when DHL got through, an Amazon network failure is the account's own and counts", async (t) => {
  const routes = { history: HISTORY, trackers: TRACKERS };
  const dhl = fakeDhlAccount({ inbox: { json: { sendungen: [], rateLimited: false } }, anonymous: ANONYMOUS });
  const world = await amazonWorld(t, routes, {}, { transport: dhl });
  await connectedAccount(world);
  assert.equal(await world.run("login", "dhl"), 0);
  routes.history = { error: "net::ERR_CONNECTION_RESET" };

  await world.run("refresh");

  const sources = await world.sourcesFile();
  assert.equal(sources.offline, false);
  assert.equal(sources.connections["amazon:Personal"].failures, 1);
  assert.equal(sources.connections.dhl.health, "ok");
});
