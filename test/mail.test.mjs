// Microsoft 365 mail as a best-effort input (#34), at the one seam: the CLI
// with a fake MCP transport answering as Softeria's ms-365-mcp-server does.
// Every mail, Order ID and item is synthetic; see fixtures/mail/softeria.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeChrome, fakeDhl, fakeDhlAccount, fakeMail, fixture, makeWorld, toolAnswer } from "./harness.mjs";
import { historyPage, trackerPage } from "./fixtures/amazon/pages.mjs";
import {
  DEVICE_CODE, DEVICE_URL, delivered, dhlNotice, digitalOrder, graphError, noAccount, orderConfirmation, outForDelivery,
  refund, shippingConfirmation, silentRefreshFailed, softeriaAccount,
} from "./fixtures/mail/softeria.mjs";

const ORDER_A = "305-5555555-5555555";
const ORDER_B = "306-6666666-6666666";
const ORDER_C = "307-7777777-7777777";
const ORDER_D = "308-8888888-8888888";
const ORDER_OLD = "309-9999999-9999999";
const ORDER_PAGE = "https://www.amazon.de/your-orders/order-details?orderID=";
const ENABLED_TOOLS = "^(list-mail-messages|get-mail-message)$";

async function mailWorld(t, account = softeriaAccount(), worldOptions = {}) {
  const world = await makeWorld({ mail: fakeMail(account.tools), ...worldOptions });
  t.after(() => world.cleanup());
  return world;
}

// Signs the mailbox in (its first sync finds nothing), as the Sources row does.
async function connectMail(world, account) {
  const mails = account.mails;
  const at = world.now.toISOString();
  account.mails = [];
  assert.equal(await world.run("login", "mail"), 0);
  account.mails = mails;
  account.searches.length = 0;
  world.mail.calls.length = 0;
  world.mail.starts.length = 0;
  // Signing in took a poll; the tests' runs start where they were.
  world.setClock(at);
}

const mode = async (path) => (await stat(path)).mode & 0o777;
const keys = async (world) => (await world.shipmentsFile()).shipments.map((s) => s.key).sort();

test("login mail shows the device code, runs the server read-only with the two mail tools, and keeps its files in the state dir, mode 600", async (t) => {
  const account = softeriaAccount({ polls: 3 });
  const seen = [];
  const verify = account.tools["verify-login"];
  account.tools["verify-login"] = (args, server) => {
    seen.push(JSON.parse(readFileSync(join(world.stateDir, "sources.json"), "utf8")).connections.mail.login);
    return verify(args, server);
  };
  const world = await mailWorld(t, account);

  assert.equal(await world.run("login", "mail"), 0);

  // While the user signs in: the code and the page, for the row and the banner.
  assert.equal(seen[0].phase, "code");
  assert.equal(seen[0].code, DEVICE_CODE);
  assert.equal(seen[0].url, DEVICE_URL);
  assert.equal(seen[0].expiresAt, "2026-09-29T10:15:00.000Z");
  assert.equal(seen.length, 3);
  assert.ok(world.output.some((line) => line.includes(DEVICE_CODE) && line.includes(DEVICE_URL)));

  // Pinned server, read-only, only the two mail read tools.
  for (const start of world.mail.starts) {
    assert.deepEqual(start.args, ["--read-only", "--enabled-tools", ENABLED_TOOLS]);
    assert.deepEqual(start.env, {
      MS365_MCP_TOKEN_CACHE_PATH: join(world.stateDir, "mail/token-cache.json"),
      MS365_MCP_SELECTED_ACCOUNT_PATH: join(world.stateDir, "mail/selected-account.json"),
      MS365_MCP_LOG_DIR: join(world.stateDir, "mail/logs"),
    });
  }
  assert.equal(await mode(join(world.stateDir, "mail/token-cache.json")), 0o600);
  assert.equal(await mode(join(world.stateDir, "mail/selected-account.json")), 0o600);
  assert.equal(await mode(join(world.stateDir, "mail")), 0o700);
  assert.equal(world.mail.open, 0);

  const conn = (await world.sourcesFile()).connections.mail;
  assert.equal(conn.health, "ok");
  assert.equal(conn.login, null);
  assert.equal(conn.lastLogin, null);
  assert.equal(conn.lastOk, "2026-09-29T10:00:15.000Z");
});

test("the first sync after login mail announces nothing it finds", async (t) => {
  const account = softeriaAccount({
    mails: [orderConfirmation({ orderId: ORDER_A, item: "Kaffeebohnen 1 kg", at: "2026-09-28T08:00:00Z" })],
  });
  const world = await mailWorld(t, account);

  assert.equal(await world.run("login", "mail"), 0);

  const file = await world.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => [s.key, s.status, s.hint]), [[`amazon:${ORDER_A}`, "Unknown", "Ordered · per mail, 28 Sep"]]);
  assert.deepEqual(file.events, []);
});

const DHL_NOTICE_NUMBER = "00340434000000000999";

test("the sender names the step of the hint, never a Status; other Amazon mail is ignored; the 30-day window is applied client-side", async (t) => {
  const account = softeriaAccount({
    mails: [
      orderConfirmation({ orderId: ORDER_A, item: "Kaffeebohnen 1 kg", at: "2026-09-28T08:00:00Z" }),
      shippingConfirmation({ orderId: ORDER_B, item: "Gartenschlauch 20 m", at: "2026-09-28T09:00:00Z" }),
      outForDelivery({ orderId: ORDER_C, item: "Kabel & Adapter-Set", at: "2026-09-29T06:00:00Z" }),
      delivered({ orderId: ORDER_D, item: "Notizbuch A5", at: "2026-09-28T15:00:00Z" }),
      // Received 31 days ago: outside the window.
      orderConfirmation({ orderId: ORDER_OLD, item: "Alte Bestellung", at: "2026-08-29T09:00:00Z" }),
      refund({ orderId: "310-1010101-1010101", at: "2026-09-27T09:00:00Z" }),
      digitalOrder({ orderId: "D01-1212121-1212121", at: "2026-09-27T09:00:00Z" }),
      dhlNotice({ at: "2026-09-29T07:00:00Z" }),
    ],
  });
  const world = await mailWorld(t, account, { transport: fakeDhl({ [DHL_NOTICE_NUMBER]: { json: fixture("dhl/in-transit.json") } }) });
  await connectMail(world, account);

  assert.equal(await world.run("refresh"), 0);

  // Two searches per run: amazon.de mail, and mail that mentions DHL; then
  // the HTML of the mail that named a new DHL number.
  assert.deepEqual(world.mail.calls.map((c) => c.name), ["list-mail-messages", "list-mail-messages", "get-mail-message"]);
  assert.deepEqual(account.searches.map((s) => s.search), ['"from:amazon.de"', '"DHL"']);
  const file = await world.shipmentsFile();
  const byKey = Object.fromEntries(file.shipments.map((s) => [s.key, s]));
  assert.deepEqual(Object.keys(byKey).sort(), [
    `amazon:${ORDER_A}`, `amazon:${ORDER_B}`, `amazon:${ORDER_C}`, `amazon:${ORDER_D}`, `dhl:${DHL_NOTICE_NUMBER}`,
  ]);
  assert.deepEqual([ORDER_A, ORDER_B, ORDER_C, ORDER_D].map((id) => [byKey[`amazon:${id}`].status, byKey[`amazon:${id}`].hint]), [
    ["Unknown", "Ordered · per mail, 28 Sep"],
    ["Unknown", "Shipped · per mail, 28 Sep"],
    ["Unknown", "Out for delivery · per mail, 29 Sep"],
    ["Unknown", "Delivered · per mail, 28 Sep"],
  ]);
  // Order level: Source Amazon, no account, no Carrier, the Order's page;
  // what the last mail said, and an Estimate as a day.
  assert.deepEqual(byKey[`amazon:${ORDER_B}`], {
    key: `amazon:${ORDER_B}`, direction: "Incoming", source: "Amazon", account: null, carrier: null, connections: ["mail"],
    title: "Gartenschlauch 20 m", status: "Unknown",
    estimate: { from: "2026-09-29", to: "2026-09-29", text: "Tue 29 Sep" }, delayed: false,
    orderId: ORDER_B, url: `${ORDER_PAGE}${ORDER_B}`, probedBy: [],
    mail: { step: "Shipped", at: "2026-09-28T09:00:00.000Z", estimate: { from: "2026-09-29", to: "2026-09-29" } },
    hint: "Shipped · per mail, 28 Sep", trackingEvent: "mail@2026-09-28T09:00:00.000Z",
    changedAt: "2026-09-29T10:00:00.000Z", discoveredAt: "2026-09-29T10:00:00.000Z", lastSeenAt: "2026-09-29T10:00:00.000Z",
    notified: { status: "Unknown", delayed: false },
  });
  assert.equal(byKey[`amazon:${ORDER_D}`].estimate, null);
  assert.equal(byKey[`amazon:${ORDER_D}`].terminalAt, undefined);
  // DHL's own notice names its number: watched, Status from the lookup.
  assert.equal(byKey[`dhl:${DHL_NOTICE_NUMBER}`].status, "In transit");
  assert.deepEqual(file.events, []);
  assert.equal((await world.sourcesFile()).connections.mail.lastCount, 5);
});

test("the latest mail about an Order decides it, and estimates are read on the day the mail came", async (t) => {
  const item = "Kaffeebohnen 1 kg";
  const account = softeriaAccount({
    mails: [
      shippingConfirmation({ orderId: ORDER_A, item, at: "2026-09-26T10:00:00Z", estimate: "Ankunft Donnerstag" }),
      orderConfirmation({ orderId: ORDER_A, item, at: "2026-09-25T10:00:00Z" }),
      orderConfirmation({ orderId: ORDER_B, item: "Gartenschlauch 20 m", at: "2026-09-27T10:00:00Z" }),
    ],
  });
  const world = await mailWorld(t, account);
  await connectMail(world, account);

  assert.equal(await world.run("refresh"), 0);

  const a = await world.shipment(`amazon:${ORDER_A}`);
  assert.equal(a.status, "Unknown");
  assert.equal(a.hint, "Shipped · per mail, 26 Sep");
  // Saturday's "Donnerstag" is the next Thursday.
  assert.deepEqual(a.estimate, { from: "2026-10-01", to: "2026-10-01", text: "Thu 1 Oct" });
  assert.deepEqual((await world.shipment(`amazon:${ORDER_B}`)).estimate, { from: "2026-10-06", to: "2026-10-08", text: "Tue 6 Oct – Thu 8 Oct" });
});

// ---- Run order and the browser route

const HISTORY_WITH_A = historyPage([{ orderId: ORDER_A, shipments: [{ packageIndex: 0, shipmentId: "Taaaaaaaa", title: "Kaffeebohnen 1 kg (Packung)" }] }]);
const TRACKER_A = trackerPage({
  orderId: ORDER_A, packageIndex: "0", shortStatus: "IN_TRANSIT", trackingId: "DE0000000005",
  progressTracker: { lastReachedMilestone: "SHIPPED", numberOfReachedMilestones: 2 },
  promise: { promiseMessage: "Lieferung morgen" },
}, { carrierLine: "Versand durch Amazon" });

test("run order is DHL, then mail, then Amazon; a mail-only Shipment merges into the account's Shipment once its history shows the Order", async (t) => {
  const order = [];
  const account = softeriaAccount({
    mails: [
      orderConfirmation({ orderId: ORDER_A, item: "Kaffeebohnen 1 kg", at: "2026-09-28T08:00:00Z" }),
      orderConfirmation({ orderId: ORDER_B, item: "Gartenschlauch 20 m", at: "2026-09-28T09:00:00Z" }),
    ],
  });
  const list = account.tools["list-mail-messages"];
  account.tools["list-mail-messages"] = (args, server) => { order.push("mail"); return list(args, server); };
  let history = historyPage([]);
  const chrome = fakeChrome({
    history: () => { order.push("amazon"); return history; },
    trackers: { [`${ORDER_A}#0`]: TRACKER_A },
    search: { [ORDER_A]: historyPage([]), [ORDER_B]: historyPage([]) },
  });
  const dhl = fakeDhlAccount({ inbox: { json: { sendungen: [] } }, enrich: { json: { sendungen: [] } } });
  const inbox = dhl.inbox;
  Object.defineProperty(dhl, "inbox", { get: () => { order.push("dhl"); return inbox; } });
  const world = await mailWorld(t, account, { chrome, transport: dhl });
  await world.run("login", "dhl");
  await world.run("accounts", "add", "Business", "--accept-risk");
  await world.run("login", "amazon:Business");
  await connectMail(world, account);

  // The history doesn't show the Orders yet (nor does the order search):
  // mail's Order-level Shipments stand, and announce nothing.
  order.length = 0;
  await world.run("refresh");
  assert.deepEqual(order.filter((x, i) => x !== order[i - 1]), ["dhl", "mail", "amazon"]);
  assert.deepEqual(await keys(world), [`amazon:${ORDER_A}`, `amazon:${ORDER_B}`]);
  assert.deepEqual((await world.shipmentsFile()).events, []);

  // Now it shows Order A: one Shipment for it, the account's, and the row
  // the user already saw becomes it without a "new".
  history = HISTORY_WITH_A;
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");
  assert.deepEqual(await keys(world), [`amazon:${ORDER_A}#0`, `amazon:${ORDER_B}`]);
  const merged = await world.shipment(`amazon:${ORDER_A}#0`);
  assert.equal(merged.account, "Business");
  assert.equal(merged.status, "In transit");
  assert.deepEqual(merged.connections, ["amazon:Business"]);
  assert.equal(merged.discoveredAt, "2026-09-29T10:00:00.000Z");
  assert.deepEqual((await world.shipmentsFile()).events, []);

  // Mail still finds Order A: the browser route's Shipment stands for it.
  world.setClock("2026-09-29T12:00:00.000Z");
  await world.run("refresh");
  assert.deepEqual(await keys(world), [`amazon:${ORDER_A}#0`, `amazon:${ORDER_B}`]);
});

test("an Order first seen in mail is read from the account's history in the same run", async (t) => {
  const account = softeriaAccount({ mails: [orderConfirmation({ orderId: ORDER_A, item: "Kaffeebohnen 1 kg", at: "2026-09-29T09:00:00Z" })] });
  let history = historyPage([]);
  const chrome = fakeChrome({ history: () => history, trackers: { [`${ORDER_A}#0`]: TRACKER_A } });
  const world = await mailWorld(t, account, { chrome });
  await world.run("accounts", "add", "Business", "--accept-risk");
  await world.run("login", "amazon:Business");
  await connectMail(world, account);
  history = HISTORY_WITH_A;

  await world.run("refresh");

  assert.deepEqual(await keys(world), [`amazon:${ORDER_A}#0`]);
  assert.deepEqual((await world.shipmentsFile()).events.map((e) => [e.kind, e.key]), [["new", `amazon:${ORDER_A}#0`]]);
});

// ---- Health: a blocked mailbox never affects the other Sources

const DHL_ELEMENT = fixture("dhl/in-transit.json");

async function dhlAndMail(t, account) {
  const dhl = fakeDhlAccount({ inbox: { json: DHL_ELEMENT }, enrich: { json: DHL_ELEMENT } });
  const world = await mailWorld(t, account, { transport: dhl });
  await world.run("login", "dhl");
  await connectMail(world, account);
  return world;
}

test("a mailbox with no signed-in account needs a login, once announced, and DHL is read as usual", async (t) => {
  const account = softeriaAccount({ mails: [orderConfirmation({ orderId: ORDER_A, item: "Kaffeebohnen 1 kg", at: "2026-09-28T08:00:00Z" })] });
  const world = await dhlAndMail(t, account);
  account.list = noAccount();

  assert.equal(await world.run("refresh"), 0);

  const { connections } = await world.sourcesFile();
  assert.equal(connections.mail.health, "needs-login");
  assert.equal(connections.mail.reason, "expired");
  assert.equal(connections.dhl.health, "ok");
  assert.equal(connections.dhl.lastOk, "2026-09-29T10:00:00.000Z");
  assert.deepEqual((await world.shipmentsFile()).events.map((e) => [e.kind, e.title]), [["connection", "Microsoft 365 mail needs a login"]]);

  // Still needs a login: retried every run, quiet; healed by a good run.
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");
  assert.equal(account.searches.length, 2);
  assert.deepEqual((await world.shipmentsFile()).events, []);
  account.list = null;
  world.setClock("2026-09-29T12:00:00.000Z");
  await world.run("refresh");
  assert.equal((await world.sourcesFile()).connections.mail.health, "ok");
  assert.ok(await world.shipment(`amazon:${ORDER_A}`));
});

test("a failed silent token refresh is a lost login, unless Softeria logged it as a network failure", async (t) => {
  const account = softeriaAccount();
  const world = await dhlAndMail(t, account);
  account.list = async (args, { env }) => {
    await mkdir(env.MS365_MCP_LOG_DIR, { recursive: true });
    await writeFile(join(env.MS365_MCP_LOG_DIR, "error.log"),
      "2026-09-29 12:00:00 ERROR: Silent token acquisition failed: network_error (correlationId: none): Network request failed\n");
    return silentRefreshFailed();
  };

  // Online (DHL got through): the mailbox's own network failure counts, once.
  await world.run("refresh");
  let mail = (await world.sourcesFile()).connections.mail;
  assert.equal(mail.health, "ok");
  assert.equal(mail.reason, "network");
  assert.equal(mail.failures, 1);

  account.list = silentRefreshFailed();
  await world.run("refresh");
  mail = (await world.sourcesFile()).connections.mail;
  assert.equal(mail.health, "needs-login");
  assert.equal(mail.reason, "expired");
});

test("offline, a mailbox that can't be reached changes nothing but the run", async (t) => {
  const account = softeriaAccount();
  const world = await mailWorld(t, account);
  await connectMail(world, account);
  const before = (await world.sourcesFile()).connections.mail;
  account.list = toolAnswer({ error: "Error in tool list-mail-messages: fetch failed" }, { isError: true });

  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");

  const sources = await world.sourcesFile();
  assert.equal(sources.offline, true);
  assert.deepEqual({ ...sources.connections.mail, lastRun: before.lastRun }, before);
});

test("a mail server that doesn't start leaves DHL alone, and after two runs the mailbox is source-down", async (t) => {
  const account = softeriaAccount();
  const world = await dhlAndMail(t, account);
  world.mail = fakeMail(account.tools, { startFails: "server" });

  await world.run("refresh");
  let { connections } = await world.sourcesFile();
  assert.equal(connections.mail.health, "ok");
  assert.equal(connections.mail.failures, 1);
  assert.equal(connections.dhl.health, "ok");

  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");
  ({ connections } = await world.sourcesFile());
  assert.equal(connections.mail.health, "source-down");
  assert.equal(connections.mail.reason, "server");
  assert.equal(connections.dhl.health, "ok");
  assert.equal(connections.dhl.lastOk, "2026-09-29T11:00:00.000Z");
  assert.deepEqual((await world.shipmentsFile()).events, []);
});

test("an answer that isn't a message list is a changed data format: source-down at once, cached Shipments stay", async (t) => {
  const account = softeriaAccount({ mails: [orderConfirmation({ orderId: ORDER_A, item: "Kaffeebohnen 1 kg", at: "2026-09-28T08:00:00Z" })] });
  const world = await mailWorld(t, account);
  await connectMail(world, account);
  await world.run("refresh");
  account.list = toolAnswer("<html>unexpected</html>");

  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");

  const mail = (await world.sourcesFile()).connections.mail;
  assert.equal(mail.health, "source-down");
  assert.equal(mail.reason, "shape");
  assert.ok(await world.shipment(`amazon:${ORDER_A}`));
});

test("Graph rate limits and server errors are counted as such", async (t) => {
  const account = softeriaAccount();
  const world = await dhlAndMail(t, account);
  account.list = graphError(429, "Too Many Requests");
  await world.run("refresh");
  assert.equal((await world.sourcesFile()).connections.mail.reason, "rate-limited");
  account.list = graphError(503, "Service Unavailable");
  await world.run("refresh");
  const mail = (await world.sourcesFile()).connections.mail;
  assert.equal(mail.reason, "http");
  assert.equal(mail.health, "source-down");
});

test("Retry with --source mail reads only the mailbox", async (t) => {
  const account = softeriaAccount({ mails: [orderConfirmation({ orderId: ORDER_A, item: "Kaffeebohnen 1 kg", at: "2026-09-28T08:00:00Z" })] });
  const world = await dhlAndMail(t, account);
  const dhlTokenRequests = world.transport.refreshTokens.length;

  assert.equal(await world.run("refresh", "--source", "mail"), 0);

  assert.equal(world.transport.refreshTokens.length, dhlTokenRequests);
  assert.equal(account.searches.length, 2);
  assert.ok(await world.shipment(`amazon:${ORDER_A}`));
});

test("a mailbox that isn't set up is never started", async (t) => {
  const world = await mailWorld(t, softeriaAccount(), { transport: fakeDhl({}) });
  assert.equal(await world.run("refresh"), 0);
  assert.equal(world.mail.starts.length, 0);
});

// ---- The Login lifecycle

test("login mail: Cancel ends it as cancelled and the mailbox stays as it was", async (t) => {
  const account = softeriaAccount({ polls: Infinity });
  const verify = account.tools["verify-login"];
  account.tools["verify-login"] = (args, server) => {
    if (account.verifies === 2) world.cancel();
    return verify(args, server);
  };
  const world = await mailWorld(t, account);

  assert.equal(await world.run("login", "mail"), 1);

  const mail = (await world.sourcesFile()).connections.mail;
  assert.equal(mail.health, "not-set-up");
  assert.equal(mail.login, null);
  assert.equal(mail.lastLogin.result, "cancelled");
  assert.equal(world.logs.at(-1), "login: Login cancelled");
  assert.equal(world.mail.open, 0);
  assert.equal(await world.exists(join(world.stateDir, "mail/token-cache.json")), false);
});

test("login mail times out after 15 minutes, the device code's lifetime", async (t) => {
  const account = softeriaAccount({ polls: Infinity });
  const world = await mailWorld(t, account);

  assert.equal(await world.run("login", "mail"), 1);

  const mail = (await world.sourcesFile()).connections.mail;
  assert.deepEqual(mail.lastLogin, { result: "timed-out", at: "2026-09-29T10:15:00.000Z" });
  assert.equal(world.logs.at(-1), "login: Login timed out after 15 min");
  assert.equal(world.mail.open, 0);
});

test("login mail is refused while another Login runs", async (t) => {
  const account = softeriaAccount({ polls: 2 });
  let other = null;
  const verify = account.tools["verify-login"];
  account.tools["verify-login"] = async (args, server) => {
    other ??= await world.run("login", "mail");
    return verify(args, server);
  };
  const world = await mailWorld(t, account);

  assert.equal(await world.run("login", "mail"), 0);
  assert.equal(other, 1);
  assert.match(world.logs.join("\n"), /Finish the Microsoft 365 mail login first/);
});

test("a re-login of a mailbox that needs one keeps its Shipments and heals it", async (t) => {
  const account = softeriaAccount({ mails: [orderConfirmation({ orderId: ORDER_A, item: "Kaffeebohnen 1 kg", at: "2026-09-28T08:00:00Z" })] });
  const world = await mailWorld(t, account);
  await connectMail(world, account);
  account.list = noAccount();
  await world.run("refresh");
  assert.equal((await world.sourcesFile()).connections.mail.health, "needs-login");
  account.list = null;
  account.verifies = 0;

  assert.equal(await world.run("login", "mail"), 0);

  assert.equal((await world.sourcesFile()).connections.mail.health, "ok");
  assert.ok(await world.shipment(`amazon:${ORDER_A}`));
  assert.deepEqual((await world.shipmentsFile()).events, []);
});

// ---- Disconnect

test("disconnect mail logs out through Softeria, deletes its files, and drops the Orders only mail knew", async (t) => {
  const account = softeriaAccount({
    mails: [
      orderConfirmation({ orderId: ORDER_A, item: "Kaffeebohnen 1 kg", at: "2026-09-28T08:00:00Z" }),
      orderConfirmation({ orderId: ORDER_B, item: "Gartenschlauch 20 m", at: "2026-09-28T09:00:00Z" }),
      orderConfirmation({ orderId: ORDER_C, item: "Kabel & Adapter-Set", at: "2026-09-28T10:00:00Z" }),
    ],
  });
  const notFound = { [ORDER_A]: historyPage([]), [ORDER_B]: historyPage([]), [ORDER_C]: historyPage([]) };
  const chrome = fakeChrome({ history: historyPage([]), trackers: { [`${ORDER_A}#0`]: TRACKER_A }, search: notFound });
  const world = await mailWorld(t, account, { chrome });
  await world.run("accounts", "add", "Business", "--accept-risk");
  await world.run("login", "amazon:Business");
  await connectMail(world, account);
  await world.run("refresh");
  // Order A merges into the account's Shipment; Order B is also added by hand.
  world.chrome = fakeChrome({ history: HISTORY_WITH_A, trackers: { [`${ORDER_A}#0`]: TRACKER_A } });
  world.chrome.clock = () => world.now;
  world.setClock("2026-09-29T11:00:00.000Z");
  await world.run("refresh");
  await world.run("add", ORDER_B);
  assert.deepEqual(await keys(world), [`amazon:${ORDER_A}#0`, `amazon:${ORDER_B}`, `amazon:${ORDER_C}`]);

  assert.equal(await world.run("disconnect", "mail"), 0);

  assert.deepEqual(world.mail.calls.map((c) => c.name).at(-1), "logout");
  assert.equal(world.mail.starts.at(-1).install, false);
  assert.equal(await world.exists(join(world.stateDir, "mail/token-cache.json")), false);
  assert.equal(await world.exists(join(world.stateDir, "mail/selected-account.json")), false);
  const mail = (await world.sourcesFile()).connections.mail;
  assert.equal(mail.health, "not-set-up");
  assert.equal(mail.since, world.now.toISOString());
  assert.deepEqual(await keys(world), [`amazon:${ORDER_A}#0`, `amazon:${ORDER_B}`]);
  assert.deepEqual((await world.shipment(`amazon:${ORDER_B}`)).connections, ["manual"]);
  assert.equal(world.output.at(-1), "Disconnected Microsoft 365 mail");

  // Not read any more.
  world.setClock("2026-09-29T12:00:00.000Z");
  const searches = account.searches.length;
  await world.run("refresh", "--source", "mail");
  assert.equal(account.searches.length, searches);
});

test("disconnect mail removes Softeria's files itself when the server can't start", async (t) => {
  const account = softeriaAccount();
  const world = await mailWorld(t, account);
  await connectMail(world, account);
  world.mail = fakeMail(account.tools, { startFails: "server" });

  assert.equal(await world.run("disconnect", "mail"), 0);

  assert.equal(await world.exists(join(world.stateDir, "mail/token-cache.json")), false);
  assert.equal(await world.exists(join(world.stateDir, "mail/selected-account.json")), false);
  assert.equal((await world.sourcesFile()).connections.mail.health, "not-set-up");
});
