// The Amazon Business order history (#64). A Business account's history has
// its own layout (fixtures/amazon/pages.mjs, businessHistoryPage): no
// `your-orders-content-container`, no `a-box delivery-box`, items as
// `<img class="itemImageSource">`. The Login waited for a history it never
// recognised and timed out. All Order IDs, image IDs, names and titles are
// synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeChrome, fakeImageCdn, makeWorld } from "./harness.mjs";
import { businessHistoryPage, RECOMMENDATIONS, signInPage, trackerPage } from "./fixtures/amazon/pages.mjs";

const SPLIT = "305-0000000-0000001"; // one Order, two Shipments
const SINGLE = "306-0000000-0000002";
const DIGITAL = "D01-0000000-0000003";
const MANUAL = "307-0000000-0000004";
const CDN = "https://m.media-amazon.com/images/I/";
const img = (id, token = "_SS142_") => `${CDN}${id}.${token}.jpg`;
const SIGN_IN_URL = "https://www.amazon.de/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.de%2Fgp%2Fcss%2Forder-history";

const tracker = (orderId, packageIndex, state = {}) => ({
  [`${orderId}#${packageIndex}`]: trackerPage({ orderId, packageIndex: String(packageIndex), shortStatus: "IN_TRANSIT", ...state }),
});
const TRACKERS = { ...tracker(SPLIT, 0), ...tracker(SPLIT, 1), ...tracker(SINGLE, 0), ...tracker(MANUAL, 0) };

const HISTORY = businessHistoryPage([
  { orderId: SPLIT, shipments: [
    // Two items in the first box: the first one's image and title stand for it.
    { packageIndex: 0, shipmentId: "Tbiz00000", title: "Druckerpapier A4", image: img("61AaBbCcDdE", "_SS284_"),
      items: [{ title: "Tonerkartusche", image: img("62FfGgHhIiJ") }] },
    { packageIndex: 1, shipmentId: "Tbiz00001", title: "Bürostuhl", image: img("63KkLlMmNnO") },
  ] },
  // Digital orders are listed in the same layout; they are never Shipments.
  { orderId: DIGITAL, shipments: [{ packageIndex: 0, shipmentId: "Tdigital0", title: "Software-Lizenz" }] },
  // The last box on the page: its chunk runs into the recommendations.
  { orderId: SINGLE, shipments: [{ packageIndex: 0, shipmentId: "Tbiz00002", title: "Schreibtischlampe", image: null }] },
], { footer: RECOMMENDATIONS, pending: 2 });

async function businessWorld(t, routes = { history: HISTORY, trackers: TRACKERS, search: {} }) {
  const cdn = fakeImageCdn();
  const world = await makeWorld({ chrome: fakeChrome(routes), transport: cdn });
  t.after(() => world.cleanup());
  assert.equal(await world.run("accounts", "add", "Firma", "--accept-risk"), 0);
  return { world, cdn };
}

const connection = async (world) => (await world.sourcesFile()).connections["amazon:Firma"];

test("a Login whose order history is in the Business layout ends ok", async (t) => {
  // The user signs in first; then the window shows the Business history.
  const { world } = await businessWorld(t, {
    history: ({ polls }) => (polls < 2 ? { url: SIGN_IN_URL, html: signInPage() } : HISTORY),
    trackers: TRACKERS,
  });

  assert.equal(await world.run("login", "amazon:Firma"), 0);

  const conn = await connection(world);
  assert.equal(conn.health, "ok");
  assert.equal(conn.login, null);
  assert.equal(conn.lastLogin, null);
  assert.equal(world.chrome.open, false);
  // The Login's first sync already lists the Business Shipments.
  const keys = (await world.shipmentsFile()).shipments.map((s) => s.key).sort();
  assert.deepEqual(keys, [`amazon:${SPLIT}#0`, `amazon:${SPLIT}#1`, `amazon:${SINGLE}#0`]);
});

test("a refresh reads the Business history's Shipments with their titles and product images", async (t) => {
  const { world, cdn } = await businessWorld(t);
  assert.equal(await world.run("login", "amazon:Firma"), 0);
  assert.equal(await world.run("refresh"), 0);

  const rows = (await world.shipmentsFile()).shipments
    .map((s) => [s.key, s.account, s.status, s.title, s.imageUrl ?? null])
    .sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(rows, [
    [`amazon:${SPLIT}#0`, "Firma", "In transit", "Druckerpapier A4", img("61AaBbCcDdE")],
    [`amazon:${SPLIT}#1`, "Firma", "In transit", "Bürostuhl", img("63KkLlMmNnO")],
    // The last box has no image of its own and never takes one from the
    // recommendations after it.
    [`amazon:${SINGLE}#0`, "Firma", "In transit", "Schreibtischlampe", null],
  ]);
  assert.deepEqual(cdn.requests.map((r) => r.url).sort(), [img("61AaBbCcDdE"), img("63KkLlMmNnO")]);
  assert.equal((await connection(world)).health, "ok");
});

test("the site header's sign-in link on the Business history is neither a challenge nor a sign-out", async (t) => {
  assert.match(HISTORY, /href="\/ap\/signin\?openid\.return_to=/);
  const routes = { history: HISTORY, trackers: TRACKERS, search: {} };
  const { world } = await businessWorld(t, routes);
  assert.equal(await world.run("login", "amazon:Firma"), 0);

  assert.equal(await world.run("refresh"), 0);
  let conn = await connection(world);
  assert.equal(conn.health, "ok");
  assert.equal(conn.reason ?? null, null);

  // The real sign-in page still is one.
  routes.history = { url: SIGN_IN_URL, html: signInPage() };
  world.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);
  conn = await connection(world);
  assert.equal(conn.health, "needs-login");
  assert.equal(conn.reason, "signed-out");
});

test("a manual Order ID is found through the order search in the Business layout", async (t) => {
  const search = {
    [MANUAL]: businessHistoryPage([{ orderId: MANUAL, shipments: [{ packageIndex: 0, shipmentId: "Tbiz00003", title: "Aktenschrank", image: img("64PpQqRrSsT") }] }]),
  };
  const { world } = await businessWorld(t, { history: HISTORY, trackers: TRACKERS, search });
  assert.equal(await world.run("login", "amazon:Firma"), 0);
  assert.equal(await world.run("add", MANUAL), 0);

  assert.equal(await world.run("refresh"), 0);

  const s = await world.shipment(`amazon:${MANUAL}#0`);
  assert.deepEqual([s.account, s.connections, s.status, s.title, s.imageUrl],
    ["Firma", ["amazon:Firma", "manual"], "In transit", "Aktenschrank", img("64PpQqRrSsT")]);
  assert.equal(await world.shipment(`amazon:${MANUAL}`), undefined);
});

test("an empty Business order search means the account doesn't own the Order", async (t) => {
  const { world } = await businessWorld(t, { history: HISTORY, trackers: TRACKERS, search: { [MANUAL]: businessHistoryPage([]) } });
  assert.equal(await world.run("login", "amazon:Firma"), 0);
  assert.equal(await world.run("add", MANUAL), 0);

  assert.equal(await world.run("refresh"), 0);

  assert.equal((await connection(world)).health, "ok");
  assert.equal(await world.shipment(`amazon:${MANUAL}#0`), undefined);
  assert.ok(await world.shipment(`amazon:${MANUAL}`));
});
