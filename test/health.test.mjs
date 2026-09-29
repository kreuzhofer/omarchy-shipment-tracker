// The Health state machine (spec #21, "Health"; decided on #19), driven by
// `refresh`: transitions and reasons, offline, the DHL empty-list checks and
// the `connection` notification events. All numbers and names are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeChrome, fakeDhl, fakeDhlAccount, fixture, makeWorld } from "./harness.mjs";
import { captchaPage, historyPage, signInPage, trackerPage } from "./fixtures/amazon/pages.mjs";

const ALL = ["00340434000000000101", "00340434000000000102", "00340434000000000103", "00340434000000000104"];
const MANUAL = "00340434000000000033";
const EMPTY = { json: { sendungen: [], mergedAnonymousShipmentListIds: [], rateLimited: false } };

function account(overrides = {}) {
  return fakeDhlAccount({
    inbox: { json: fixture("dhl/account/inbox.json") },
    enrich: (ids) => ids.length === ALL.length && ALL.every((id) => ids.includes(id))
      ? { json: fixture("dhl/account/enriched.json") }
      : { json: fixture("dhl/account/inbox.json") },
    ...overrides,
  });
}

async function connectedWorld(t, dhl = account(), options = {}) {
  const world = await makeWorld({ transport: dhl, ...options });
  t.after(() => world.cleanup());
  assert.equal(await world.run("login", "dhl"), 0);
  return world;
}

async function refreshAt(world, iso) {
  world.setClock(iso);
  assert.equal(await world.run("refresh"), 0);
  return (await world.sourcesFile()).connections.dhl;
}

const connectionEvents = async (world) => (await world.shipmentsFile()).events.filter((e) => e.kind === "connection");

// ---- Transitions and reasons

test("one http failure is counted; the second run in a row makes DHL source-down", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  dhl.inbox = { status: 503, text: "Service Unavailable" };

  let conn = await refreshAt(world, "2026-09-29T11:00:00.000Z");
  assert.equal(conn.health, "ok");
  assert.equal(conn.reason, "http");
  assert.equal(conn.failures, 1);

  conn = await refreshAt(world, "2026-09-29T12:00:00.000Z");
  assert.equal(conn.health, "source-down");
  assert.equal(conn.reason, "http");
  assert.equal(conn.failures, 2);
  assert.equal(conn.since, "2026-09-29T12:00:00.000Z");
  assert.equal(conn.lastOk, "2026-09-29T10:00:00.000Z");
});

test("one shape failure makes DHL source-down at once", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  dhl.inbox = { json: { shipments: [] } };

  const conn = await refreshAt(world, "2026-09-29T11:00:00.000Z");
  assert.equal(conn.health, "source-down");
  assert.equal(conn.reason, "shape");
});

test("rate limiting is recorded as rate-limited", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  dhl.inbox = { json: { sendungen: [], rateLimited: true } };

  const conn = await refreshAt(world, "2026-09-29T11:00:00.000Z");
  assert.equal(conn.reason, "rate-limited");
  assert.equal(conn.failures, 1);
});

test("a successful refresh resets a source-down Connection to ok", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  const inbox = dhl.inbox;
  dhl.inbox = { status: 500, text: "" };
  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  await refreshAt(world, "2026-09-29T12:00:00.000Z");

  dhl.inbox = inbox;
  const conn = await refreshAt(world, "2026-09-29T13:00:00.000Z");
  assert.deepEqual(
    { health: conn.health, reason: conn.reason, failures: conn.failures, lastOk: conn.lastOk, since: conn.since },
    { health: "ok", reason: null, failures: 0, lastOk: "2026-09-29T13:00:00.000Z", since: "2026-09-29T13:00:00.000Z" },
  );
});

test("an auth failure moves a source-down Connection to needs-login", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  dhl.inbox = { json: { shipments: [] } };
  await refreshAt(world, "2026-09-29T11:00:00.000Z");

  dhl.token = () => ({ status: 400, json: { error: "invalid_grant" } });
  const conn = await refreshAt(world, "2026-09-29T12:00:00.000Z");
  assert.equal(conn.health, "needs-login");
  assert.equal(conn.reason, "expired");
});

test("a needs-login Connection stays needs-login when its token refresh fails otherwise", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  dhl.token = () => ({ status: 400, json: { error: "invalid_grant" } });
  await refreshAt(world, "2026-09-29T11:00:00.000Z");

  dhl.token = () => ({ status: 502, text: "Bad Gateway" });
  await refreshAt(world, "2026-09-29T12:00:00.000Z");
  const conn = await refreshAt(world, "2026-09-29T13:00:00.000Z");
  assert.equal(conn.health, "needs-login");
  assert.equal(conn.reason, "expired");
  assert.equal(conn.since, "2026-09-29T11:00:00.000Z");
  assert.equal(conn.lastRun, "2026-09-29T13:00:00.000Z");
});

test("Amazon records the browser reason when Chrome doesn't come up", async (t) => {
  const world = await makeWorld({ chrome: fakeChrome({ history: historyPage([]) }), transport: fakeDhl({}) });
  t.after(() => world.cleanup());
  await world.run("accounts", "add", "Personal", "--accept-risk");
  assert.equal(await world.run("login", "amazon:Personal"), 0);
  world.chrome = fakeChrome({}, { launchFails: true });

  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  const conn = (await world.sourcesFile()).connections["amazon:Personal"];
  assert.equal(conn.reason, "browser");
  assert.equal(conn.failures, 1);
});

// ---- Offline

test("offline: when every request fails on the network, no Health changes and the run is marked offline", async (t) => {
  const anonymous = { [MANUAL]: { json: fixture("dhl/in-transit.json") } };
  const dhl = account({ anonymous });
  const world = await connectedWorld(t, dhl);
  await world.run("add", MANUAL);
  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  const before = (await world.sourcesFile()).connections.dhl;
  const shipments = (await world.shipmentsFile()).shipments;

  dhl.token = () => ({ network: true });
  anonymous[MANUAL] = { network: true };
  for (const at of ["2026-09-29T12:00:00.000Z", "2026-09-29T13:00:00.000Z", "2026-09-29T14:00:00.000Z"]) {
    await refreshAt(world, at);
  }

  const sources = await world.sourcesFile();
  assert.equal(sources.offline, true);
  assert.equal(sources.lastRun, "2026-09-29T14:00:00.000Z");
  // The subtitle's "updated … ago" is the last run that got through.
  assert.equal(sources.lastOnline, "2026-09-29T11:00:00.000Z");
  assert.deepEqual({ ...sources.connections.dhl, lastRun: before.lastRun }, before);
  assert.equal(sources.connections.dhl.lastRun, "2026-09-29T14:00:00.000Z");
  assert.deepEqual((await world.shipmentsFile()).shipments, shipments);
  assert.deepEqual(await connectionEvents(world), []);
});

test("a DHL network failure counts when a lookup in the same run got through", async (t) => {
  const dhl = account({ anonymous: { [MANUAL]: { json: fixture("dhl/in-transit.json") } } });
  const world = await connectedWorld(t, dhl);
  await world.run("add", MANUAL);
  dhl.inbox = { network: true };

  let conn = await refreshAt(world, "2026-09-29T11:00:00.000Z");
  assert.equal(conn.failures, 1);
  assert.equal(conn.reason, "network");
  const sources = await world.sourcesFile();
  assert.equal(sources.offline, false);
  assert.equal(sources.lastOnline, "2026-09-29T11:00:00.000Z");

  conn = await refreshAt(world, "2026-09-29T12:00:00.000Z");
  assert.equal(conn.health, "source-down");
});

// ---- The DHL empty list

test("DHL empty after a non-empty run: a second token refresh, then needs-login/empty-list; nothing is deleted", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  const shipments = (await world.shipmentsFile()).shipments;
  dhl.inbox = EMPTY;
  const used = dhl.refreshTokens.length;

  const conn = await refreshAt(world, "2026-09-29T11:00:00.000Z");
  assert.equal(dhl.refreshTokens.length - used, 2);
  assert.equal(conn.health, "needs-login");
  assert.equal(conn.reason, "empty-list");
  assert.equal(conn.lastCount, 4);
  assert.deepEqual((await world.shipmentsFile()).shipments, shipments);
});

test("DHL empty once but listing again after the second token refresh stays ok", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  const inbox = dhl.inbox;
  let asks = 0;
  dhl.inbox = { get json() { return asks++ === 0 ? EMPTY.json : inbox.json; } };

  const conn = await refreshAt(world, "2026-09-29T11:00:00.000Z");
  assert.equal(conn.health, "ok");
  assert.equal(conn.lastCount, 4);
  assert.equal((await world.shipmentsFile()).shipments.length, 4);
});

test("an account that has always been empty stays ok, with one token refresh per run", async (t) => {
  const dhl = account({ inbox: EMPTY, enrich: null });
  const world = await connectedWorld(t, dhl);
  const used = dhl.refreshTokens.length;

  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  const conn = await refreshAt(world, "2026-09-29T12:00:00.000Z");
  assert.equal(dhl.refreshTokens.length - used, 2);
  assert.equal(conn.health, "ok");
  assert.equal(conn.lastCount, 0);
});

test("logging in again after empty-list is ok even if the account is now empty", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  dhl.inbox = EMPTY;
  await refreshAt(world, "2026-09-29T11:00:00.000Z");

  world.setClock("2026-09-29T11:30:00.000Z");
  assert.equal(await world.run("login", "dhl"), 0);
  let conn = (await world.sourcesFile()).connections.dhl;
  assert.equal(conn.health, "ok");
  assert.equal(conn.lastCount, 0);
  // Its cached Shipments stay until retention drops them.
  assert.equal((await world.shipmentsFile()).shipments.length, 4);

  conn = await refreshAt(world, "2026-09-29T12:00:00.000Z");
  assert.equal(conn.health, "ok");
});

// ---- connection events

test("entering needs-login emits one connection event; staying there emits none", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  const { lastEventId } = await world.shipmentsFile();
  dhl.token = () => ({ status: 400, json: { error: "invalid_grant" } });

  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  assert.deepEqual(await connectionEvents(world), [{
    id: lastEventId + 1,
    kind: "connection",
    connection: "dhl",
    health: "needs-login",
    reason: "expired",
    title: "DHL needs a login",
    body: "The list may be incomplete until you log in again",
  }]);
  assert.equal((await world.shipmentsFile()).lastEventId, lastEventId + 1);

  await refreshAt(world, "2026-09-29T12:00:00.000Z");
  assert.deepEqual(await connectionEvents(world), []);
  assert.equal((await world.shipmentsFile()).lastEventId, lastEventId + 1);
});

test("a connection event again only after the Connection was ok in between", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  const issue = dhl.token;
  const reject = () => ({ status: 400, json: { error: "invalid_grant" } });

  dhl.token = reject;
  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  const first = (await connectionEvents(world))[0].id;

  // needs-login → (a server hiccup) → still needs-login: nothing new.
  dhl.token = () => ({ status: 503, text: "" });
  await refreshAt(world, "2026-09-29T12:00:00.000Z");
  dhl.token = reject;
  await refreshAt(world, "2026-09-29T13:00:00.000Z");
  assert.deepEqual(await connectionEvents(world), []);

  dhl.token = issue;
  await refreshAt(world, "2026-09-29T14:00:00.000Z");
  assert.equal((await world.sourcesFile()).connections.dhl.health, "ok");
  dhl.token = reject;
  await refreshAt(world, "2026-09-29T15:00:00.000Z");
  const again = await connectionEvents(world);
  assert.equal(again.length, 1);
  assert.ok(again[0].id > first);
});

test("the empty-list event says the login was probably lost", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  dhl.inbox = EMPTY;

  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  const [event] = await connectionEvents(world);
  assert.equal(event.title, "DHL needs a login");
  assert.equal(event.reason, "empty-list");
  assert.equal(event.body, "DHL returned no Shipments, which usually means the login was lost");
  assert.equal(event.url, undefined);
});

test("source-down emits no event", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  dhl.inbox = { json: { shipments: [] } };

  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  assert.equal((await world.sourcesFile()).connections.dhl.health, "source-down");
  assert.deepEqual((await world.shipmentsFile()).events, []);
});

test("an Amazon account that loses its session emits one event naming its label", async (t) => {
  const routes = { history: historyPage([]), trackers: {} };
  const world = await makeWorld({ chrome: fakeChrome(routes), transport: fakeDhl({}) });
  t.after(() => world.cleanup());
  await world.run("accounts", "add", "Business", "--accept-risk");
  assert.equal(await world.run("login", "amazon:Business"), 0);
  routes.history = { url: "https://www.amazon.de/ap/signin?openid.return_to=x", html: signInPage() };

  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  const events = await connectionEvents(world);
  assert.equal(events.length, 1);
  assert.deepEqual(
    { connection: events[0].connection, reason: events[0].reason, title: events[0].title },
    { connection: "amazon:Business", reason: "signed-out", title: "Amazon · Business needs a login" },
  );

  // Not polled while needs-login, and not announced again.
  await refreshAt(world, "2026-09-29T12:00:00.000Z");
  assert.deepEqual(await connectionEvents(world), []);
});

test("a challenge during an Amazon Login's first sync is announced right away, once", async (t) => {
  const ORDER = "301-0000000-0000001";
  const routes = {
    history: historyPage([{ orderId: ORDER, shipments: [{ packageIndex: 0, shipmentId: "Taaaaaaaa", title: "Ein Kabel" }] }]),
    trackers: { [`${ORDER}#0`]: captchaPage() },
  };
  const world = await makeWorld({ chrome: fakeChrome(routes), transport: fakeDhl({}) });
  t.after(() => world.cleanup());
  await world.run("accounts", "add", "Business", "--accept-risk");

  world.setClock("2026-09-29T10:30:00.000Z");
  await world.run("login", "amazon:Business");

  const conn = (await world.sourcesFile()).connections["amazon:Business"];
  assert.deepEqual({ health: conn.health, reason: conn.reason }, { health: "needs-login", reason: "challenge" });
  const events = await connectionEvents(world);
  assert.deepEqual(events.map((e) => ({ connection: e.connection, reason: e.reason, title: e.title, body: e.body })), [{
    connection: "amazon:Business",
    reason: "challenge",
    title: "Amazon · Business needs a login",
    body: "Amazon · Business asks for a security check",
  }]);
  assert.equal((await world.shipmentsFile()).lastEventId, events[0].id);

  // The next refresh doesn't announce it again.
  routes.trackers[`${ORDER}#0`] = trackerPage({ orderId: ORDER, packageIndex: "0", shortStatus: "IN_TRANSIT" });
  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  assert.deepEqual(await connectionEvents(world), []);
});

test("connection events follow the run's Shipment events with increasing ids", async (t) => {
  const anonymous = { [MANUAL]: { json: fixture("dhl/in-transit.json") } };
  const dhl = account({ anonymous });
  const world = await connectedWorld(t, dhl);
  await world.run("add", MANUAL);
  await refreshAt(world, "2026-09-29T11:00:00.000Z");
  // The manual add goes out for delivery in the same run DHL loses its login.
  anonymous[MANUAL] = { json: fixture("dhl/out-for-delivery.json") };
  dhl.token = () => ({ status: 400, json: { error: "invalid_grant" } });

  await refreshAt(world, "2026-09-29T12:00:00.000Z");
  const { events, lastEventId } = await world.shipmentsFile();
  assert.deepEqual(events.map((e) => e.kind), ["status", "connection"]);
  assert.equal(events[1].id, events[0].id + 1);
  assert.equal(lastEventId, events[1].id);
});
