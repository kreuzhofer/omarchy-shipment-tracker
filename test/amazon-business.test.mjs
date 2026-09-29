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

// ---- #68: images in whatever markup the live page uses, and cards that
// render after the load event.

const PLACEHOLDER = "https://m.media-amazon.com/images/G/01/x-locale/common/grey-pixel.gif";
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
const ORDERS = ["311-0000000-0000011", "312-0000000-0000012", "313-0000000-0000013", "314-0000000-0000014", "315-0000000-0000015", "316-0000000-0000016"];

test("a Business box's image is found on any Amazon image host, lazy-loaded, in srcset, or after the tracker link", async (t) => {
  const variants = [
    // Another Amazon CDN host, a size token with a comma.
    { src: "https://images-na.ssl-images-amazon.com/images/I/71NaHostAaA._AC_UL75_SR75,75_.jpg" },
    // Lazy loading: a placeholder in src, the image in data-src.
    { src: PLACEHOLDER, "data-src": "https://images-eu.ssl-images-amazon.com/images/I/72LazyBbBbB._SX100_.jpg" },
    // Only the high-resolution attribute.
    { src: GIF, "data-a-hires": "https://m.media-amazon.com/images/I/73HiresCcCc._SS400_.jpg" },
    // A srcset (its first entry), protocol-relative, without a size token.
    { src: GIF, srcset: "//m.media-amazon.com/images/I/74SrcsetDdD.jpg 1x, https://m.media-amazon.com/images/I/74SrcsetDdD._SS284_.jpg 2x" },
  ];
  const history = businessHistoryPage([
    ...variants.map((imageAttrs, i) => ({ orderId: ORDERS[i], shipments: [{ packageIndex: 0, shipmentId: `Tvar0000${i}`, title: `Artikel ${i}`, imageAttrs }] })),
    // The items after the tracker link in the box.
    { orderId: ORDERS[4], shipments: [{ packageIndex: 0, shipmentId: "Tvar00004", title: "Artikel 4", image: img("75AfterEeEe"), itemsAfterLink: true }] },
    // The last box: nothing but a placeholder; the recommendations after it are no item of its.
    { orderId: ORDERS[5], shipments: [{ packageIndex: 0, shipmentId: "Tvar00005", title: "Artikel 5", imageAttrs: { src: PLACEHOLDER } }] },
  ], { footer: RECOMMENDATIONS });
  const trackers = Object.assign({}, ...ORDERS.map((o) => tracker(o, 0)));
  const { world, cdn } = await businessWorld(t, { history, trackers, search: {} });
  assert.equal(await world.run("login", "amazon:Firma"), 0);

  const imageUrl = async (i) => (await world.shipment(`amazon:${ORDERS[i]}#0`)).imageUrl ?? null;
  assert.deepEqual(await Promise.all(ORDERS.map((o, i) => imageUrl(i))), [
    "https://images-na.ssl-images-amazon.com/images/I/71NaHostAaA._SS142_.jpg",
    "https://images-eu.ssl-images-amazon.com/images/I/72LazyBbBbB._SS142_.jpg",
    img("73HiresCcCc"),
    img("74SrcsetDdD"),
    img("75AfterEeEe"),
    null,
  ]);
  // Fetched from the host the page named, at the one size.
  assert.deepEqual(cdn.requests.map((r) => new URL(r.url).host).sort(), [
    "images-eu.ssl-images-amazon.com", "images-na.ssl-images-amazon.com", "m.media-amazon.com", "m.media-amazon.com", "m.media-amazon.com",
  ]);
});

test("each account's run logs its boxes, those with an image URL and the image hosts, never an ID or URL", async (t) => {
  const history = businessHistoryPage([
    { orderId: ORDERS[0], shipments: [{ packageIndex: 0, shipmentId: "Tlog00000", title: "Artikel 0", imageAttrs: { src: GIF, "data-src": img("81LogAaAaAa") } }] },
    { orderId: ORDERS[1], shipments: [{ packageIndex: 0, shipmentId: "Tlog00001", title: "Artikel 1", image: "https://images-na.ssl-images-amazon.com/images/I/82LogBbBbBb._SS142_.jpg" }] },
    { orderId: ORDERS[2], shipments: [{ packageIndex: 0, shipmentId: "Tlog00002", title: "Artikel 2", image: null }] },
  ]);
  const trackers = Object.assign({}, ...ORDERS.slice(0, 3).map((o) => tracker(o, 0)));
  const { world } = await businessWorld(t, { history, trackers, search: {} });
  assert.equal(await world.run("login", "amazon:Firma"), 0);
  world.logs.length = 0;
  world.setClock("2026-09-29T11:00:00.000Z");

  assert.equal(await world.run("refresh"), 0);

  assert.deepEqual(world.logs.filter((l) => l.startsWith("refresh: amazon history")), [
    "refresh: amazon history 3 box(es), 3 listed, 2 with an image URL; image hosts: data: 1, images-na.ssl-images-amazon.com 1, m.media-amazon.com 1",
  ]);
  for (const line of world.logs) {
    assert.doesNotMatch(line, /\d{3}-\d{7}-\d{7}|\/images\/I\/|https?:/);
  }
});

// Only skeletons: the cards haven't rendered yet.
const UNRENDERED = businessHistoryPage([], { pending: 3 });

test("a Login's first sync waits for the Business cards to render instead of reading skeletons", async (t) => {
  // Signed in at the first read; the cards render a few reads later
  // (`polls`: reads since the navigation).
  const { world } = await businessWorld(t, {
    history: ({ polls }) => (polls < 6 ? UNRENDERED : HISTORY),
    trackers: TRACKERS,
  });

  assert.equal(await world.run("login", "amazon:Firma"), 0);

  const keys = (await world.shipmentsFile()).shipments.map((s) => s.key).sort();
  assert.deepEqual(keys, [`amazon:${SPLIT}#0`, `amazon:${SPLIT}#1`, `amazon:${SINGLE}#0`]);
  // The same page read again, no navigation beyond the history and the three trackers.
  assert.equal(world.chrome.navigations.length, 4);
});

test("a refresh waits for the Business cards to render, up to about 10 s, without counting it as a page", async (t) => {
  let history = HISTORY;
  const { world } = await businessWorld(t, { history: (ctx) => (typeof history === "function" ? history(ctx) : history), trackers: TRACKERS, search: {} });
  assert.equal(await world.run("login", "amazon:Firma"), 0);

  // Rendered a few reads after the load event.
  history = ({ polls }) => (polls < 4 ? UNRENDERED : HISTORY);
  world.chrome.navigations.length = 0;
  world.logs.length = 0;
  world.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);
  assert.ok(world.logs.includes("refresh: amazon read 4 page(s), 3 Shipment(s)"), world.logs.join("\n"));
  assert.equal(world.chrome.navigations.length, 4);

  // Never rendered: after about 10 s of reads the page is taken as it is.
  history = UNRENDERED;
  world.sleeps.length = 0;
  world.setClock("2026-09-29T12:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);
  const renderWaits = world.sleeps.filter((ms) => ms === 1000).length;
  assert.ok(renderWaits >= 9 && renderWaits <= 11, `${renderWaits} render waits`);
  assert.equal((await connection(world)).health, "ok");
});

test("the order search waits for the Business cards to render too", async (t) => {
  const found = businessHistoryPage([{ orderId: MANUAL, shipments: [{ packageIndex: 0, shipmentId: "Tbiz00003", title: "Aktenschrank" }] }]);
  const { world } = await businessWorld(t, { history: HISTORY, trackers: TRACKERS, search: { [MANUAL]: ({ polls }) => (polls < 4 ? businessHistoryPage([], { pending: 1 }) : found) } });
  assert.equal(await world.run("login", "amazon:Firma"), 0);
  assert.equal(await world.run("add", MANUAL), 0);

  assert.equal(await world.run("refresh"), 0);

  assert.equal((await world.shipment(`amazon:${MANUAL}#0`))?.account, "Firma");
});

test("a Login whose first sync saw only unrendered Business cards keeps the next run that reads them quiet", async (t) => {
  const DELIVERED = { shortStatus: "DELIVERED", progressTracker: { lastReachedMilestone: "DELIVERED", numberOfReachedMilestones: 4 } };
  const trackers = { ...tracker(SPLIT, 0, DELIVERED), ...tracker(SPLIT, 1), ...tracker(SINGLE, 0) };
  const routes = { history: UNRENDERED, trackers, search: {} };
  const { world } = await businessWorld(t, routes);

  // The cards never render during the Login: its first sync lists nothing.
  assert.equal(await world.run("login", "amazon:Firma"), 0);
  assert.equal((await connection(world)).health, "ok");
  assert.equal((await world.shipmentsFile()).shipments.filter((s) => s.account === "Firma").length, 0);

  // The next refresh reads them all, one Delivered: the backlog, told nothing
  // (no `new`, no `status`).
  routes.history = HISTORY;
  world.setClock("2026-09-29T11:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);
  const file = await world.shipmentsFile();
  assert.deepEqual(file.shipments.filter((s) => s.account === "Firma").map((s) => [s.key, s.status]).sort(), [
    [`amazon:${SPLIT}#0`, "Delivered"], [`amazon:${SPLIT}#1`, "In transit"], [`amazon:${SINGLE}#0`, "In transit"],
  ]);
  assert.deepEqual(file.events, []);

  // From then on, changes are told as usual.
  routes.trackers = { ...trackers, ...tracker(SINGLE, 0, DELIVERED) };
  world.setClock("2026-09-29T12:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);
  assert.deepEqual((await world.shipmentsFile()).events.map((e) => [e.kind, e.key, e.status]), [["status", `amazon:${SINGLE}#0`, "Delivered"]]);
});
