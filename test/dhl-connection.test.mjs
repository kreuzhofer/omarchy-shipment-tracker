// The DHL Connection: `login dhl` against a fake Chrome, then `refresh` reading
// the Sendungsliste (token refresh, inbox, piececode enrichment) from a fake
// DHL account. All tracking numbers, names and tokens here are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fakeBrowser, fakeDhlAccount, fixture, makeWorld } from "./harness.mjs";

const INCOMING = "00340434000000000101"; // complete in the inbox, In transit
const STUB = "00340434000000000102"; // stub in the inbox, Out for delivery once enriched
const OUTGOING = "00340434000000000103"; // Outgoing stub, Announced once enriched
const ARCHIVED = "00340434000000000104"; // archived stub, Delivered once enriched
const ALL = [INCOMING, STUB, OUTGOING, ARCHIVED];

// The enrichment only answers complete when asked for every id at once, as
// the spike found live: asking for a subset turns the others back into stubs.
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

test("login dhl saves the tokens (mode 600) and its first sync shows every Shipment complete", async (t) => {
  const world = await connectedWorld(t);

  assert.equal(await world.tokenFileMode(), 0o600);
  assert.equal(await world.stateDirMode(), 0o700);
  const file = await world.shipmentsFile();
  const byKey = Object.fromEntries(file.shipments.map((s) => [s.trackingNumber, s]));
  assert.deepEqual(Object.keys(byKey).sort(), ALL);
  assert.equal(byKey[INCOMING].status, "In transit");
  assert.equal(byKey[STUB].status, "Out for delivery");
  assert.equal(byKey[OUTGOING].status, "Announced");
  assert.equal(byKey[ARCHIVED].status, "Delivered");
  assert.deepEqual(byKey[STUB], {
    key: `dhl:${STUB}`,
    direction: "Incoming",
    source: "DHL",
    account: null,
    carrier: "DHL",
    connections: ["dhl"],
    title: "Amazon",
    status: "Out for delivery",
    estimate: byKey[STUB].estimate,
    delayed: false,
    trackingNumber: STUB,
    url: `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${STUB}`,
    changedAt: "2026-09-29T10:00:00.000Z",
    discoveredAt: "2026-09-29T10:00:00.000Z",
    lastSeenAt: "2026-09-29T10:00:00.000Z",
  });
  assert.deepEqual(file.events, []);
});

test("sources.json shows the dhl Connection as ok after its first sync", async (t) => {
  const world = await connectedWorld(t);

  const sources = await world.sourcesFile();
  assert.deepEqual(sources.connections.dhl, {
    health: "ok",
    reason: null,
    since: "2026-09-29T10:00:00.000Z",
    lastRun: "2026-09-29T10:00:00.000Z",
    lastOk: "2026-09-29T10:00:00.000Z",
    failures: 0,
    message: null,
    lastCount: 4,
    login: null,
    lastLogin: null,
  });
  assert.equal(sources.lastRun, "2026-09-29T10:00:00.000Z");
});

test("Outgoing Shipments get Direction Outgoing and the recipient as title", async (t) => {
  const world = await connectedWorld(t);

  const s = await world.shipment(`dhl:${OUTGOING}`);
  assert.equal(s.direction, "Outgoing");
  assert.equal(s.title, "Erika Musterfrau");
});

test("the login profile lives in the tracker's own data dir, apart from the normal browser profile", async (t) => {
  const browser = fakeBrowser();
  const world = await connectedWorld(t, account(), { browser });

  const [{ profileDir, url }] = browser.launches;
  assert.equal(profileDir, join(world.env.XDG_DATA_HOME, "omarchy-shipment-tracker", "dhl"));
  assert.ok(!profileDir.startsWith(join(world.env.HOME, ".config")));
  const authorize = new URL(url);
  assert.equal(authorize.origin, "https://login.dhl.de");
  assert.equal(authorize.searchParams.get("redirect_uri"), "dhllogin://de.deutschepost.dhl/login");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(JSON.parse(authorize.searchParams.get("claims")).id_token.post_number === null);
});

test("the code exchange proves PKCE: the verifier hashes to the authorize request's challenge", async (t) => {
  const browser = fakeBrowser();
  const dhl = account();
  const issue = dhl.token;
  const forms = [];
  dhl.token = (form) => { forms.push(form); return issue(form); };
  await connectedWorld(t, dhl, { browser });

  const challenge = new URL(browser.launches[0].url).searchParams.get("code_challenge");
  const exchange = forms.find((f) => f.get("grant_type") === "authorization_code");
  assert.equal(exchange.get("code"), "fake-code");
  assert.equal(createHash("sha256").update(exchange.get("code_verifier")).digest("base64url"), challenge);
});

test("every refresh renews the ID token first and saves the rotated refresh token", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  assert.equal((await world.tokenFile()).refresh_token, "refresh-2");

  world.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);
  world.setClock("2026-09-29T12:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);

  // The code exchange issued refresh-1; login's first sync renewed it too.
  // Each run used exactly the token the run before saved.
  assert.deepEqual(dhl.refreshTokens, ["refresh-1", "refresh-2", "refresh-3"]);
  assert.equal((await world.tokenFile()).refresh_token, "refresh-4");
  assert.equal(await world.tokenFileMode(), 0o600);
  assert.equal((await world.sourcesFile()).connections.dhl.lastOk, "2026-09-29T12:00:00.000Z");
});

test("the rotated refresh token is saved before the inbox call, so a failed inbox loses nothing", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  const before = await world.shipmentsFile();

  dhl.inbox = { network: true };
  world.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);
  const saved = (await world.tokenFile()).refresh_token;

  dhl.inbox = { json: fixture("dhl/account/inbox.json") };
  world.setClock("2026-09-29T12:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);

  assert.equal(dhl.refreshTokens.at(-1), saved);
  assert.deepEqual((await world.shipmentsFile()).shipments.map((s) => s.key), before.shipments.map((s) => s.key));
  assert.equal((await world.sourcesFile()).connections.dhl.health, "ok");
});

test("a rejected refresh token (invalid_grant) makes the Connection needs-login/expired and keeps its Shipments", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  const before = await world.shipmentsFile();

  dhl.token = () => ({ status: 400, json: { error: "invalid_grant", error_description: "refresh token expired" } });
  world.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);

  const dhlSource = (await world.sourcesFile()).connections.dhl;
  assert.equal(dhlSource.health, "needs-login");
  assert.equal(dhlSource.reason, "expired");
  assert.equal(dhlSource.since, "2026-09-29T11:00:00.000Z");
  assert.equal(dhlSource.lastOk, "2026-09-29T10:00:00.000Z");
  assert.deepEqual((await world.shipmentsFile()).shipments, before.shipments);
});

test("a needs-login Connection retries the token refresh each run and heals", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  const issue = dhl.token;
  dhl.token = () => ({ status: 401, json: { error: "invalid_grant" } });
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");

  dhl.token = issue;
  world.setClock("2026-09-29T12:00:00.000Z");
  await world.run("refresh");

  const dhlSource = (await world.sourcesFile()).connections.dhl;
  assert.equal(dhlSource.health, "ok");
  assert.equal(dhlSource.reason, null);
});

test("logging in again after needs-login makes the Connection ok", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);
  const issue = dhl.token;
  dhl.token = (form) => form.get("grant_type") === "refresh_token" ? { status: 400, json: { error: "invalid_grant" } } : issue(form);
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");
  assert.equal((await world.sourcesFile()).connections.dhl.health, "needs-login");

  dhl.token = issue;
  world.setClock("2026-09-29T11:30:00.000Z");
  assert.equal(await world.run("login", "dhl"), 0);

  const dhlSource = (await world.sourcesFile()).connections.dhl;
  assert.equal(dhlSource.health, "ok");
  assert.equal(dhlSource.since, "2026-09-29T11:30:00.000Z");
});

test("an ID token without post_number makes the Connection needs-login/account-link-lost", async (t) => {
  const dhl = account();
  const world = await connectedWorld(t, dhl);

  dhl.claims = { email_verified: true };
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");

  const dhlSource = (await world.sourcesFile()).connections.dhl;
  assert.equal(dhlSource.health, "needs-login");
  assert.equal(dhlSource.reason, "account-link-lost");
});

test("a manually added number the Sendungsliste lists takes its Direction and isn't looked up anonymously", async (t) => {
  // No anonymous routes: an anonymous lookup would fail the test loudly.
  const dhl = account();
  const world = await makeWorld({ transport: dhl });
  t.after(() => world.cleanup());
  await world.run("add", OUTGOING);
  assert.equal((await world.shipment(`dhl:${OUTGOING}`)).direction, "Incoming");

  world.setClock("2026-09-29T10:05:00.000Z");
  assert.equal(await world.run("login", "dhl"), 0);

  const s = await world.shipment(`dhl:${OUTGOING}`);
  assert.equal(s.direction, "Outgoing");
  assert.equal(s.title, "Erika Musterfrau");
  assert.equal(s.status, "Announced");
  assert.deepEqual(s.connections.sort(), ["dhl", "manual"]);
  assert.equal(s.discoveredAt, "2026-09-29T10:00:00.000Z");
  assert.equal((await world.shipmentsFile()).shipments.length, ALL.length);
});

test("an empty Sendungsliste is ok and needs no enrichment call", async (t) => {
  const dhl = account({ inbox: { json: { sendungen: [], mergedAnonymousShipmentListIds: [], rateLimited: false } }, enrich: null });
  const world = await connectedWorld(t, dhl);

  assert.deepEqual((await world.shipmentsFile()).shipments, []);
  const dhlSource = (await world.sourcesFile()).connections.dhl;
  assert.equal(dhlSource.health, "ok");
  assert.equal(dhlSource.lastCount, 0);
});

test("a failed inbox or enrichment call never changes or deletes cached Shipments", async (t) => {
  for (const [name, change] of [
    ["inbox HTTP 503", (dhl) => { dhl.inbox = { status: 503, text: "Service Unavailable" }; }],
    ["enrichment HTTP 500", (dhl) => { dhl.enrich = { status: 500, text: "Internal Server Error" }; }],
    ["inbox without sendungen", (dhl) => { dhl.inbox = { json: { shipments: [] } }; }],
    ["rate limited", (dhl) => { dhl.inbox = { json: { sendungen: [], rateLimited: true } }; }],
  ]) {
    const dhl = account();
    const world = await connectedWorld(t, dhl);
    const before = await world.shipmentsFile();

    change(dhl);
    world.setClock("2026-09-29T11:00:00.000Z");
    assert.equal(await world.run("refresh"), 0, name);

    assert.deepEqual((await world.shipmentsFile()).shipments, before.shipments, name);
    const dhlSource = (await world.sourcesFile()).connections.dhl;
    assert.equal(dhlSource.lastOk, "2026-09-29T10:00:00.000Z", name);
    assert.equal(dhlSource.failures, 1, name);
  }
});

test("without a login, refresh leaves DHL alone and the Connection not set up", async (t) => {
  const dhl = account({ inbox: null, enrich: null });
  dhl.token = () => { throw new Error("no token request expected"); };
  const world = await makeWorld({ transport: dhl });
  t.after(() => world.cleanup());

  assert.equal(await world.run("refresh"), 0);

  assert.deepEqual((await world.sourcesFile()).connections, {});
});

test("a cancelled or timed-out login leaves no tokens and doesn't set up the Connection", async (t) => {
  for (const outcome of ["cancelled", "timed-out", "browser"]) {
    const world = await makeWorld({ transport: account(), browser: fakeBrowser({ outcome }) });
    t.after(() => world.cleanup());

    assert.equal(await world.run("login", "dhl"), 1, outcome);

    await assert.rejects(world.tokenFile(), { code: "ENOENT" });
    const sources = await world.sourcesFile().catch(() => ({ connections: {} }));
    assert.notEqual(sources.connections.dhl?.health, "ok", outcome);
  }
});

test("login rejects a redirect whose state doesn't match", async (t) => {
  const browser = fakeBrowser();
  browser.catchRedirect = async ({ redirectPrefix }) => `${redirectPrefix}?code=x&state=forged`;
  const world = await makeWorld({ transport: account(), browser });
  t.after(() => world.cleanup());

  assert.equal(await world.run("login", "dhl"), 1);
  await assert.rejects(world.tokenFile(), { code: "ENOENT" });
});

test("login and refresh logs carry counts and Health only, never tokens, numbers or names", async (t) => {
  const world = await connectedWorld(t);
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");

  const printed = [...world.logs, ...world.output].join("\n");
  assert.ok(world.logs.length > 0);
  for (const secret of ["00340434", "refresh-", "Musterfrau", "Beispiel", "0000000000", "fake-code"]) {
    assert.ok(!printed.includes(secret), `${secret} leaked in: ${printed}`);
  }
});

test("login with an unknown Connection prints usage", async (t) => {
  const world = await makeWorld();
  t.after(() => world.cleanup());

  assert.equal(await world.run("login", "nope"), 2);
});

// #23's Estimate and Delayed apply to Sendungsliste Shipments as they do to manual adds.
test("a Sendungsliste Shipment whose delivery window moves later turns Delayed", async (t) => {
  const withWindow = (from, to) => {
    const json = fixture("dhl/account/enriched.json");
    Object.assign(json.sendungen.find((e) => e.id === INCOMING).sendungsdetails.zustellung,
      { zustellzeitfensterVon: from, zustellzeitfensterBis: to });
    return { json };
  };
  let enriched = withWindow("2026-09-30", "2026-09-30");
  const world = await connectedWorld(t, account({ enrich: () => enriched }));
  const first = await world.shipment(`dhl:${INCOMING}`);
  assert.equal(first.delayed, false);
  assert.equal(first.estimate.text, "Wed 30 Sep");

  enriched = withWindow("2026-10-01", "2026-10-02");
  world.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await world.run("refresh", "--source", "dhl"), 0);

  const s = await world.shipment(`dhl:${INCOMING}`);
  assert.equal(s.delayed, true);
  assert.equal(s.estimate.text, "Thu 1 Oct – Fri 2 Oct");
});

test("a --source dhl run without a login doesn't leave the header reading Refreshing…", async (t) => {
  const world = await makeWorld({ transport: account({ inbox: null, enrich: null }) });
  t.after(() => world.cleanup());

  assert.equal(await world.run("refresh", "--source", "dhl"), 0);

  assert.equal((await world.sourcesFile()).refreshing, null);
});
