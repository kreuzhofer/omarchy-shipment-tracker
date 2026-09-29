// The password-manager hint (#51): a Login window whose profile has no
// extension yet opens a second, background tab with a local page pointing to
// installing a password manager there; the hidden refresh never does. Whether
// a login profile has an extension is `hasExtensions` on its Connection in
// sources.json (missing means none), for the Sources page. All names and numbers are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakeBrowser, fakeChrome, fakeDhl, fakeDhlAccount, fixture, installExtension, makeWorld } from "./harness.mjs";
import { historyPage, trackerPage } from "./fixtures/amazon/pages.mjs";

const HINT_PAGE = fileURLToPath(new URL("../plugin/cli/login-hint.html", import.meta.url));
const HINT_URL = pathToFileURL(HINT_PAGE).href;
const HINT_TAB = { url: HINT_URL, background: true };
// Chrome puts these into every new profile by itself; they are not the user's.
const BUILT_IN = ["ghbmnnjooekpmoecnnnilnnbdlolhkhi", "nmmhkkegccagdldgiimedpiccmgmieda"];
const ORDER = "331-0000000-0000001";
const ROUTES = {
  history: historyPage([{ orderId: ORDER, shipments: [{ packageIndex: 0, shipmentId: "T0", title: "Lampe" }] }]),
  trackers: { [`${ORDER}#0`]: trackerPage({ orderId: ORDER, packageIndex: "0", shortStatus: "IN_TRANSIT" }) },
};

async function dhlWorld(t) {
  const w = await makeWorld({
    transport: fakeDhlAccount({ inbox: { json: fixture("dhl/account/inbox.json") }, enrich: { json: fixture("dhl/account/enriched.json") } }),
  });
  t.after(() => w.cleanup());
  return w;
}

async function amazonWorld(t) {
  const w = await makeWorld({ chrome: fakeChrome(ROUTES), transport: fakeDhl({}) });
  t.after(() => w.cleanup());
  assert.equal(await w.run("accounts", "add", "Personal", "--accept-risk"), 0);
  return w;
}

const connection = async (w, key) => (await w.sourcesFile()).connections[key];
const dhlProfile = (w) => join(w.dataDir, "dhl");
const amazonProfile = (w) => join(w.dataDir, "amazon/Personal");

test("the hint page is a local page in the plugin that points to the Chrome Web Store", () => {
  assert.ok(existsSync(HINT_PAGE));
  const html = readFileSync(HINT_PAGE, "utf8");
  assert.match(html, /https:\/\/chromewebstore\.google\.com\/detail\/[^"]*hdokiejnpimakedhajhdlcegeplioahd/);
  assert.doesNotMatch(html, /<script/i);
});

test("a DHL Login in a profile without extensions opens the hint tab in the background, next to the login page", async (t) => {
  const w = await dhlWorld(t);

  assert.equal(await w.run("login", "dhl"), 0);

  const [loginPage, ...others] = w.browser.targets;
  assert.equal(loginPage.background, false);
  assert.match(loginPage.url, /^https:\/\/login\.dhl\.de\//);
  assert.deepEqual(others, [HINT_TAB]);
  assert.equal((await connection(w, "dhl")).hasExtensions ?? false, false);
});

test("Chrome's own built-in extensions don't count as a password manager", async (t) => {
  const w = await dhlWorld(t);
  for (const id of BUILT_IN) await installExtension(dhlProfile(w), id);

  assert.equal(await w.run("login", "dhl"), 0);

  assert.deepEqual(w.browser.targets.slice(1), [HINT_TAB]);
  assert.equal((await connection(w, "dhl")).hasExtensions ?? false, false);
});

test("an extension installed during a Login is recorded, and the next DHL Login opens no hint tab", async (t) => {
  const w = await dhlWorld(t);
  w.browser = fakeBrowser({ outcome: "open" });
  const done = w.run("login", "dhl");
  await w.browser.opened;
  await installExtension(dhlProfile(w));
  w.browser.finish("success");
  assert.equal(await done, 0);
  assert.equal((await connection(w, "dhl")).hasExtensions, true);

  w.browser = fakeBrowser();
  assert.equal(await w.run("login", "dhl"), 0);

  assert.equal(w.browser.targets.length, 1);
  assert.equal(w.browser.targets[0].background, false);
});

test("a cancelled DHL Login still records an extension installed meanwhile", async (t) => {
  const w = await dhlWorld(t);
  w.browser = fakeBrowser({ outcome: "open" });
  const done = w.run("login", "dhl");
  await w.browser.opened;
  await installExtension(dhlProfile(w));
  w.cancel();
  assert.equal(await done, 1);

  const conn = await connection(w, "dhl");
  assert.equal(conn.lastLogin.result, "cancelled");
  assert.equal(conn.hasExtensions, true);
});

test("an Amazon Login in a profile without extensions opens the hint tab in the background; the login page stays in the first tab", async (t) => {
  const w = await amazonWorld(t);

  assert.equal(await w.run("login", "amazon:Personal"), 0);

  assert.deepEqual(w.chrome.targets, [HINT_TAB]);
  // Every navigation (the sign-in and the first sync) happens in the tab the
  // tracker attached to, never in the hint tab.
  assert.ok(w.chrome.navigations.length > 0);
  assert.ok(w.chrome.navigations.every((n) => n.url.startsWith("https://www.amazon.de/")));
  assert.equal((await connection(w, "amazon:Personal")).hasExtensions ?? false, false);
});

test("an Amazon Login in a profile with an extension opens no hint tab", async (t) => {
  const w = await amazonWorld(t);
  await installExtension(amazonProfile(w));

  assert.equal(await w.run("login", "amazon:Personal"), 0);

  assert.deepEqual(w.chrome.targets, []);
  assert.equal((await connection(w, "amazon:Personal")).hasExtensions, true);
});

test("the hidden refresh never opens the hint tab, and records an extension installed since", async (t) => {
  const w = await amazonWorld(t);
  assert.equal(await w.run("login", "amazon:Personal"), 0);
  w.chrome.targets.length = 0;
  w.chrome.launches.length = 0;

  w.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);
  assert.equal(w.chrome.launches.length, 1);
  assert.equal(w.chrome.launches[0].hidden, true);
  assert.deepEqual(w.chrome.targets, []);
  assert.equal((await connection(w, "amazon:Personal")).hasExtensions ?? false, false);

  await installExtension(amazonProfile(w));
  w.setClock("2026-09-29T12:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);
  assert.deepEqual(w.chrome.targets, []);
  assert.equal((await connection(w, "amazon:Personal")).hasExtensions, true);
});

test("refresh records an extension in the DHL login profile too", async (t) => {
  const w = await dhlWorld(t);
  assert.equal(await w.run("login", "dhl"), 0);
  await installExtension(dhlProfile(w));

  w.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await w.run("refresh"), 0);

  assert.equal((await connection(w, "dhl")).hasExtensions, true);
  assert.equal((await connection(w, "mail"))?.hasExtensions, undefined);
});
