// The Login lifecycle (spec #21, "Login window lifecycle"; #30): the `login`
// and `lastLogin` fields in sources.json, the 15-minute deadline, Cancel,
// one Login at a time and stale Logins. All names and numbers are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeBrowser, fakeChrome, fakeDhl, fakeDhlAccount, fixture, holdLock, makeWorld } from "./harness.mjs";
import { historyPage, signInPage, trackerPage } from "./fixtures/amazon/pages.mjs";

const START = "2026-09-29T10:00:00.000Z";
const DEADLINE = "2026-09-29T10:15:00.000Z";
const DHL_UNIT = "shipment-tracker-login-dhl";
const ORDER = "331-0000000-0000001";
const SIGN_IN = { url: "https://www.amazon.de/ap/signin", html: signInPage() };
const HISTORY = historyPage([{ orderId: ORDER, shipments: [{ packageIndex: 0, shipmentId: "T0", title: "Lampe" }] }]);
const TRACKERS = { [`${ORDER}#0`]: trackerPage({ orderId: ORDER, packageIndex: "0", shortStatus: "IN_TRANSIT" }) };

const dhlAccount = () => fakeDhlAccount({
  inbox: { json: fixture("dhl/account/inbox.json") },
  enrich: { json: fixture("dhl/account/enriched.json") },
});

async function world(t, options = {}) {
  const w = await makeWorld({ now: START, transport: dhlAccount(), ...options });
  t.after(() => w.cleanup());
  return w;
}

const connection = async (w, key) => (await w.sourcesFile()).connections[key];

// Starts `login dhl` with a window that stays open; resolves once it is open,
// with `done`, the Login's exit code to come.
async function openDhlLogin(w) {
  w.browser = fakeBrowser({ outcome: "open" });
  const done = w.run("login", "dhl");
  await w.browser.opened;
  return { done };
}

// ---- The login field and the deadline

test("a Login records its phase, start, 15-minute deadline and returnTo while the window is open", async (t) => {
  const w = await world(t);
  const { done } = await openDhlLogin(w);

  const conn = await connection(w, "dhl");
  assert.equal(conn.health, "not-set-up");
  assert.deepEqual(conn.login, {
    phase: "window", startedAt: START, expiresAt: DEADLINE, returnTo: "not-set-up", unit: null, pid: process.pid,
  });
  assert.equal(w.browser.launches[0].timeoutMs, 15 * 60_000);

  w.browser.finish("success");
  assert.equal(await done, 0);
  const after = await connection(w, "dhl");
  assert.equal(after.health, "ok");
  assert.equal(after.login, null);
  assert.equal(after.lastLogin, null);
});

test("closing the DHL window ends the Login as cancelled, the deadline as timed-out; Health stays not set up", async (t) => {
  for (const result of ["cancelled", "timed-out"]) {
    const w = await world(t, { browser: fakeBrowser({ outcome: result }) });

    assert.equal(await w.run("login", "dhl"), 1);

    const conn = await connection(w, "dhl");
    assert.equal(conn.health, "not-set-up", result);
    assert.equal(conn.login, null);
    assert.deepEqual(conn.lastLogin, { result, at: START });
    await assert.rejects(w.tokenFile(), { code: "ENOENT" });
  }
});

test("Chrome not starting ends the Login as failed", async (t) => {
  const w = await world(t, { browser: fakeBrowser({ outcome: "browser" }) });

  assert.equal(await w.run("login", "dhl"), 1);

  assert.deepEqual((await connection(w, "dhl")).lastLogin, { result: "failed", at: START });
});

test("a failed re-login of a Connection that needs a login leaves its Health, reason and tokens as they were", async (t) => {
  const dhl = dhlAccount();
  const w = await world(t, { transport: dhl });
  assert.equal(await w.run("login", "dhl"), 0);
  dhl.token = () => ({ status: 400, json: { error: "invalid_grant" } });
  w.setClock("2026-09-29T11:00:00.000Z");
  await w.run("refresh");
  const before = await connection(w, "dhl");
  assert.equal(before.health, "needs-login");
  const tokens = await readFile(join(w.stateDir, "dhl-tokens.json"), "utf8");

  const { done } = await openDhlLogin(w);
  assert.equal((await connection(w, "dhl")).login.returnTo, "needs-login");
  w.cancel();
  assert.equal(await done, 1);

  const after = await connection(w, "dhl");
  assert.deepEqual(after.lastLogin, { result: "cancelled", at: "2026-09-29T11:00:00.000Z" });
  assert.deepEqual({ ...after, lastLogin: null }, before);
  assert.equal(await readFile(join(w.stateDir, "dhl-tokens.json"), "utf8"), tokens);
});

test("a voluntary re-login of an ok Connection that times out leaves it ok", async (t) => {
  const w = await world(t);
  assert.equal(await w.run("login", "dhl"), 0);
  w.browser = fakeBrowser({ outcome: "timed-out" });

  assert.equal(await w.run("login", "dhl"), 1);

  const conn = await connection(w, "dhl");
  assert.equal(conn.health, "ok");
  assert.equal(conn.lastLogin.result, "timed-out");
});

test("the next Login clears lastLogin", async (t) => {
  const w = await world(t, { browser: fakeBrowser({ outcome: "cancelled" }) });
  assert.equal(await w.run("login", "dhl"), 1);
  w.browser = fakeBrowser({ outcome: "open" });

  const done = w.run("login", "dhl");
  await w.browser.opened;
  assert.equal((await connection(w, "dhl")).lastLogin, null);
  w.browser.finish("success");
  assert.equal(await done, 0);
});

// ---- Cancel

test("Cancel ends an open DHL Login as cancelled", async (t) => {
  const w = await world(t);
  const { done } = await openDhlLogin(w);

  w.cancel();

  assert.equal(await done, 1);
  const conn = await connection(w, "dhl");
  assert.equal(conn.login, null);
  assert.deepEqual(conn.lastLogin, { result: "cancelled", at: START });
  await assert.rejects(w.tokenFile(), { code: "ENOENT" });
});

// ---- Amazon

async function amazonWorld(t, routes) {
  const w = await world(t, { chrome: fakeChrome(routes), transport: fakeDhl({}) });
  assert.equal(await w.run("accounts", "add", "Personal", "--accept-risk"), 0);
  return w;
}

test("an Amazon Login nobody finishes times out after 15 minutes, closes its window and keeps the profile", async (t) => {
  const w = await amazonWorld(t, { history: SIGN_IN });

  assert.equal(await w.run("login", "amazon:Personal"), 1);

  assert.equal(w.logs.at(-1), "login: Login timed out after 15 min");
  assert.equal(w.chrome.open, false);
  assert.ok(w.now.getTime() >= Date.parse(DEADLINE));
  const conn = await connection(w, "amazon:Personal");
  assert.equal(conn.health, "not-set-up");
  assert.equal(conn.login, null);
  assert.equal(conn.lastLogin.result, "timed-out");
  assert.ok(await w.exists(join(w.dataDir, "amazon/Personal")));
});

test("Cancel ends an Amazon Login as cancelled and closes its window", async (t) => {
  let w;
  w = await amazonWorld(t, {
    history: ({ polls }) => {
      if (polls === 3) w.cancel();
      return SIGN_IN;
    },
  });

  assert.equal(await w.run("login", "amazon:Personal"), 1);

  assert.equal(w.logs.at(-1), "login: Login cancelled");
  assert.equal(w.chrome.open, false);
  assert.ok(w.now.getTime() < Date.parse(DEADLINE));
  assert.equal((await connection(w, "amazon:Personal")).lastLogin.result, "cancelled");
});

test("an Amazon Login finding its profile held by a refresh shows waiting, then signs in", async (t) => {
  const w = await amazonWorld(t, { history: HISTORY, trackers: TRACKERS });
  const release = await holdLock(join(w.dataDir, "amazon/Personal"));

  const done = w.run("login", "amazon:Personal");
  let phase;
  for (let i = 0; i < 100 && phase !== "waiting"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    phase = (await connection(w, "amazon:Personal")).login?.phase;
  }
  assert.equal(phase, "waiting");
  assert.equal(w.chrome.launches.length, 0);
  await release();

  assert.equal(await done, 0);
  const conn = await connection(w, "amazon:Personal");
  assert.equal(conn.health, "ok");
  assert.equal(conn.login, null);
});

test("Cancel while waiting for the profile ends the Login as cancelled without opening a window", async (t) => {
  const w = await amazonWorld(t, { history: HISTORY, trackers: TRACKERS });
  const release = await holdLock(join(w.dataDir, "amazon/Personal"));

  const done = w.run("login", "amazon:Personal");
  while ((await connection(w, "amazon:Personal")).login?.phase !== "waiting") await new Promise((resolve) => setTimeout(resolve, 20));
  w.cancel();
  await release();

  assert.equal(await done, 1);
  assert.equal(w.chrome.launches.length, 0);
  assert.equal((await connection(w, "amazon:Personal")).lastLogin.result, "cancelled");
});

// ---- One Login at a time

test("while one Login runs, another is refused and opens no window", async (t) => {
  const w = await amazonWorld(t, { history: HISTORY, trackers: TRACKERS });
  const { done } = await openDhlLogin(w);

  assert.equal(await w.run("login", "amazon:Personal"), 1);
  assert.equal(w.logs.at(-1), "login: Finish the DHL login first");
  assert.equal(w.chrome.launches.length, 0);
  assert.equal((await connection(w, "amazon:Personal")).login, null);

  assert.equal(await w.run("login", "dhl"), 1);
  assert.equal(w.logs.at(-1), "login: Finish the DHL login first");
  assert.equal(w.browser.launches.length, 1);

  w.browser.finish("cancelled");
  assert.equal(await done, 1);
  assert.equal(await w.run("login", "amazon:Personal"), 0);
});

// ---- Stale Logins

test("refresh clears a Login whose unit is no longer running as failed", async (t) => {
  const w = await world(t);
  w.env.SHIPMENT_TRACKER_UNIT = DHL_UNIT;
  w.activeUnits.add(DHL_UNIT);
  const { done } = await openDhlLogin(w);
  assert.equal((await connection(w, "dhl")).login.unit, DHL_UNIT);

  assert.equal(await w.run("refresh"), 0);
  assert.equal((await connection(w, "dhl")).login.phase, "window");

  w.activeUnits.delete(DHL_UNIT);
  w.setClock("2026-09-29T10:05:00.000Z");
  assert.equal(await w.run("refresh"), 0);

  const conn = await connection(w, "dhl");
  assert.equal(conn.login, null);
  assert.deepEqual(conn.lastLogin, { result: "failed", at: "2026-09-29T10:05:00.000Z" });
  assert.equal(conn.health, "not-set-up");

  // The process that was cleared doesn't overwrite what the sweep decided.
  w.browser.finish("cancelled");
  assert.equal(await done, 1);
  assert.equal((await connection(w, "dhl")).lastLogin.result, "failed");
});

test("a Login more than 5 min past its deadline is stale even if its unit still runs", async (t) => {
  const w = await world(t);
  w.env.SHIPMENT_TRACKER_UNIT = DHL_UNIT;
  w.activeUnits.add(DHL_UNIT);
  const { done } = await openDhlLogin(w);

  w.setClock("2026-09-29T10:20:00.000Z");
  assert.equal(await w.run("refresh"), 0);
  assert.notEqual((await connection(w, "dhl")).login, null);

  w.setClock("2026-09-29T10:20:01.000Z");
  assert.equal(await w.run("refresh"), 0);
  assert.equal((await connection(w, "dhl")).lastLogin.result, "failed");

  w.browser.finish("timed-out");
  await done;
});

test("the plugin's clear-stale-logins on load clears a stale Login and keeps a running one", async (t) => {
  const w = await world(t);
  w.env.SHIPMENT_TRACKER_UNIT = DHL_UNIT;
  w.activeUnits.add(DHL_UNIT);
  const { done } = await openDhlLogin(w);

  assert.equal(await w.run("clear-stale-logins"), 0);
  assert.notEqual((await connection(w, "dhl")).login, null);

  w.activeUnits.delete(DHL_UNIT);
  assert.equal(await w.run("clear-stale-logins"), 0);
  assert.equal((await connection(w, "dhl")).lastLogin.result, "failed");

  w.browser.finish("cancelled");
  await done;
});

test("a stale Login doesn't block the next one", async (t) => {
  const w = await amazonWorld(t, { history: HISTORY, trackers: TRACKERS });
  w.env.SHIPMENT_TRACKER_UNIT = DHL_UNIT;
  const { done } = await openDhlLogin(w); // its unit isn't running: a crashed Login
  delete w.env.SHIPMENT_TRACKER_UNIT;

  assert.equal(await w.run("login", "amazon:Personal"), 0);

  const { connections } = await w.sourcesFile();
  assert.equal(connections.dhl.lastLogin.result, "failed");
  assert.equal(connections["amazon:Personal"].health, "ok");
  w.browser.finish("cancelled");
  await done;
});
