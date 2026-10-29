// Background refresh is opt-in (#90): nothing goes to ~/.config/systemd/user
// until the user turns it on. The choice is `backgroundRefresh` in
// sources.json ("on" | "off" | null = never asked); `install` / `uninstall`
// record it, and `ensure-timers` (run by the plugin on load) only repairs
// the units when it is "on". Existing installs count as "on". A successful
// Login records `loggedInAt`, which is when the plugin asks. Synthetic data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fakeBrowser, fakeDhlAccount, fixture, makeWorld } from "./harness.mjs";

const START = "2026-09-29T10:00:00.000Z";

async function world(t, options = {}) {
  const w = await makeWorld({
    now: START,
    transport: fakeDhlAccount({ inbox: { json: fixture("dhl/account/inbox.json") }, enrich: { json: fixture("dhl/account/enriched.json") } }),
    ...options,
  });
  t.after(() => w.cleanup());
  return w;
}

const unitDir = (w) => join(w.env.XDG_CONFIG_HOME, "systemd/user");
const units = async (w) => (await readdir(unitDir(w)).catch(() => [])).sort();
const choice = async (w) => (await w.sourcesFile().catch(() => ({}))).backgroundRefresh ?? null;

// ---- Turning it on and off

test("on a fresh install, ensure-timers writes no units, calls no systemctl and records no choice", async (t) => {
  const w = await world(t);

  assert.equal(await w.run("ensure-timers"), 0);

  assert.deepEqual(await units(w), []);
  assert.deepEqual(w.systemctl, []);
  assert.equal(await choice(w), null);
});

test("install records the choice as on; ensure-timers then repairs a unit that went missing", async (t) => {
  const w = await world(t);

  assert.equal(await w.run("install"), 0);
  assert.equal(await choice(w), "on");
  assert.equal((await units(w)).length, 5);

  await rm(join(unitDir(w), "shipment-tracker-refresh.timer"));
  w.systemctl.length = 0;
  assert.equal(await w.run("ensure-timers"), 0);

  assert.equal((await units(w)).includes("shipment-tracker-refresh.timer"), true);
  assert.deepEqual(w.systemctl.filter((a) => a[0] === "enable").map((a) => a.at(-1)),
    ["shipment-tracker-refresh.timer", "shipment-tracker-refresh-close.timer"]);
});

test("uninstall records the choice as off, and ensure-timers leaves it off", async (t) => {
  const w = await world(t);
  assert.equal(await w.run("install"), 0);

  assert.equal(await w.run("uninstall"), 0);
  assert.equal(await choice(w), "off");
  assert.deepEqual(await units(w), []);

  w.systemctl.length = 0;
  assert.equal(await w.run("ensure-timers"), 0);
  assert.deepEqual(await units(w), []);
  assert.deepEqual(w.systemctl, []);
  assert.equal(await choice(w), "off");
});

test("uninstall with nothing installed (Not now) records off without touching systemd", async (t) => {
  const w = await world(t);

  assert.equal(await w.run("uninstall"), 0);

  assert.equal(await choice(w), "off");
  assert.deepEqual(w.systemctl, []);
  assert.deepEqual(await units(w), []);
});

test("an existing install from before #90 counts as on: ensure-timers records it and keeps the units", async (t) => {
  const w = await world(t);
  await mkdir(unitDir(w), { recursive: true });
  await writeFile(join(unitDir(w), "shipment-tracker-refresh.timer"), "[Timer]\nOnCalendar=hourly\n");

  assert.equal(await w.run("ensure-timers"), 0);

  assert.equal(await choice(w), "on");
  assert.equal((await units(w)).length, 5);
});

test("the choice survives refresh runs", async (t) => {
  const w = await world(t);
  assert.equal(await w.run("uninstall"), 0);

  assert.equal(await w.run("login", "dhl"), 0);
  w.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);

  assert.equal(await choice(w), "off");
});

// ---- When the plugin asks

test("a successful Login records loggedInAt; one that doesn't succeed keeps the last one", async (t) => {
  const w = await world(t);

  assert.equal(await w.run("login", "dhl"), 0);
  assert.equal((await w.sourcesFile()).connections.dhl.loggedInAt, START);

  w.setClock("2026-09-29T12:00:00.000Z");
  w.browser = fakeBrowser({ outcome: "cancelled" });
  assert.equal(await w.run("login", "dhl"), 1);
  assert.equal((await w.sourcesFile()).connections.dhl.loggedInAt, START);
});
