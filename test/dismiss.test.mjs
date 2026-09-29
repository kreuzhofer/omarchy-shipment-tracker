// Dismissed Shipments (#35) at the refresh seam: `dismiss <key>` hides a
// Shipment until it gets a real update (a change in Status, Estimate or
// Delayed, or a new tracking event); refreshes that find nothing new keep it
// hidden. Only shipments.json is looked at. All tracking numbers, Order IDs
// and names here are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeChrome, fakeDhl, fakeDhlAccount, fixture, makeWorld } from "./harness.mjs";
import { historyPage, trackerPage } from "./fixtures/amazon/pages.mjs";

const A = "00340434000000000301";
const B = "00340434000000000302";

// The Incoming in-transit element of the account fixture, patched to a Status,
// a delivery window and extra tracking events.
function parcel(id, status, { window = ["2026-09-30", "2026-09-30"], extraEvents = [] } = {}) {
  const e = structuredClone(fixture("dhl/account/enriched.json").sendungen[0]);
  e.id = id;
  e.sendungsinfo.gesuchteSendungsnummer = id;
  e.sendungsinfo.sendungsname = "Beispiel Shop GmbH";
  e.sendungsinfo.sendungsrichtung = "ANKOMMEND";
  const d = e.sendungsdetails;
  d.sendungsnummern.sendungsnummer = id;
  const v = d.sendungsverlauf;
  if (status === "Out for delivery") v.fortschritt = 4;
  if (status === "Delivered") { d.istZugestellt = true; v.fortschritt = 5; }
  [d.zustellung.zustellzeitfensterVon, d.zustellung.zustellzeitfensterBis] = window;
  for (const text of extraEvents) {
    v.status = text;
    v.events.push({ datum: "2026-09-29T15:10:00+02:00", status: text, ruecksendung: false });
  }
  return e;
}

function account(list) {
  const dhl = fakeDhlAccount({});
  dhl.show = (elements) => {
    dhl.inbox = { json: { sendungen: elements, mergedAnonymousShipmentListIds: [], rateLimited: false } };
    dhl.enrich = dhl.inbox;
  };
  dhl.show(list);
  return dhl;
}

// Logged in to DHL with `first` as the Sendungsliste (first sync done).
async function connected(t, first) {
  const dhl = account(first);
  const world = await makeWorld({ transport: dhl });
  t.after(() => world.cleanup());
  assert.equal(await world.run("login", "dhl"), 0);
  return { world, dhl };
}

let minute = 0;
async function refreshWith(world, dhl, list) {
  dhl.show(list);
  world.setClock(new Date(Date.parse("2026-09-29T11:00:00.000Z") + ++minute * 60000).toISOString());
  assert.equal(await world.run("refresh"), 0);
  return world.shipmentsFile();
}

const dismissedAt = async (world, key) => (await world.shipment(key)).dismissedAt ?? null;

async function dismiss(world, key) {
  assert.equal(await world.run("dismiss", key), 0);
  assert.notEqual(await dismissedAt(world, key), null);
}

test("dismiss stores when on the Shipment; refreshes that find nothing new keep it Dismissed", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit"), parcel(B, "In transit")]);
  world.setClock("2026-09-29T10:30:00.000Z");

  assert.equal(await world.run("dismiss", `dhl:${A}`), 0);
  assert.deepEqual(world.output.at(-1), "Dismissed 1 Shipment");
  assert.equal(await dismissedAt(world, `dhl:${A}`), "2026-09-29T10:30:00.000Z");
  assert.equal(await dismissedAt(world, `dhl:${B}`), null);

  await refreshWith(world, dhl, [parcel(A, "In transit"), parcel(B, "Out for delivery")]);
  await refreshWith(world, dhl, [parcel(A, "In transit"), parcel(B, "Out for delivery")]);

  assert.equal(await dismissedAt(world, `dhl:${A}`), "2026-09-29T10:30:00.000Z");
});

test("a refresh that can't reach DHL keeps the Shipment Dismissed", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit")]);
  await dismiss(world, `dhl:${A}`);

  dhl.inbox = { network: true };
  world.setClock("2026-09-29T12:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);

  assert.notEqual(await dismissedAt(world, `dhl:${A}`), null);
});

const TRIGGERS = [
  ["a Status change", parcel(A, "Out for delivery")],
  ["an Estimate change", parcel(A, "In transit", { window: ["2026-09-29T14:00:00+02:00", "2026-09-29T16:00:00+02:00"] })],
  // Delayed only turns on when the window moves later, so it always comes
  // with an Estimate change.
  ["becoming Delayed", parcel(A, "In transit", { window: ["2026-10-02", "2026-10-02"] })],
  ["a new tracking event in the same Status", parcel(A, "In transit", { extraEvents: ["Die Sendung wurde im Ziel-Paketzentrum bearbeitet."] })],
];

for (const [what, reading] of TRIGGERS) {
  test(`${what} clears the dismissal`, async (t) => {
    const { world, dhl } = await connected(t, [parcel(A, "In transit")]);
    await dismiss(world, `dhl:${A}`);

    await refreshWith(world, dhl, [reading]);

    const s = await world.shipment(`dhl:${A}`);
    assert.equal(s.dismissedAt ?? null, null);
    if (what === "becoming Delayed") assert.equal(s.delayed, true);
  });
}

test("a dismissed Shipment still notifies, and the update brings it back", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit")]);
  await dismiss(world, `dhl:${A}`);

  const file = await refreshWith(world, dhl, [parcel(A, "Out for delivery")]);

  assert.deepEqual(file.events.map((e) => [e.kind, e.key, e.status]), [["status", `dhl:${A}`, "Out for delivery"]]);
  assert.equal(file.shipments.find((s) => s.key === `dhl:${A}`).dismissedAt ?? null, null);
});

test("undismiss shows the Shipment again; a later refresh with nothing new leaves it shown", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit")]);
  await dismiss(world, `dhl:${A}`);

  assert.equal(await world.run("undismiss", `dhl:${A}`), 0);
  assert.equal(world.output.at(-1), "Undismissed 1 Shipment");
  assert.equal(await dismissedAt(world, `dhl:${A}`), null);

  await refreshWith(world, dhl, [parcel(A, "In transit")]);
  assert.equal(await dismissedAt(world, `dhl:${A}`), null);
});

test("dismiss and undismiss need a known Shipment key", async (t) => {
  const { world } = await connected(t, [parcel(A, "In transit")]);

  assert.equal(await world.run("dismiss", `dhl:${B}`), 2);
  assert.match(world.logs.at(-1), /^dismiss: No such Shipment/);
  assert.equal(await world.run("undismiss", `dhl:${B}`), 2);
  assert.equal(await world.run("dismiss"), 2);
  assert.equal(await dismissedAt(world, `dhl:${A}`), null);
});

test("retention drops a Dismissed Shipment like any other, and its dismissal doesn't bring it back", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Delivered"), parcel(B, "In transit")]);
  await dismiss(world, `dhl:${A}`);

  // DHL's archive keeps listing the parcel after it is dropped.
  world.setClock("2026-10-30T10:00:00.000Z");
  dhl.show([parcel(A, "Delivered"), parcel(B, "In transit")]);
  assert.equal(await world.run("refresh"), 0);
  let file = await world.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => s.key), [`dhl:${B}`]);
  assert.ok(file.dropped.some((d) => d.key === `dhl:${A}`));

  world.setClock("2026-10-30T11:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);
  assert.equal(await world.run("undismiss", `dhl:${A}`), 2);
  file = await world.shipmentsFile();
  assert.deepEqual(file.shipments.map((s) => s.key), [`dhl:${B}`]);
  assert.deepEqual(file.events.filter((e) => e.key === `dhl:${A}`), []);
});

// ---- Amazon: its promise text is reworded as the day comes closer

const ORDER = "302-5555555-5555555";
const HISTORY = historyPage([{ orderId: ORDER, shipments: [{ packageIndex: 0, shipmentId: "Teeeeeeee", title: "Tischlampe" }] }]);
const tracker = (promiseMessage, reached = 2) => trackerPage({
  orderId: ORDER, packageIndex: "0", shortStatus: "IN_TRANSIT", trackingId: "DE0000000301",
  progressTracker: { lastTransitionPercentComplete: 50, lastReachedMilestone: "SHIPPED", numberOfReachedMilestones: reached },
  promise: { promiseMessage },
}, { carrierLine: "Versand durch Amazon" });

test("Amazon: the same day reworded keeps it Dismissed; a new milestone clears it", async (t) => {
  const routes = { history: HISTORY, trackers: { [`${ORDER}#0`]: tracker("Lieferung morgen") } };
  const world = await makeWorld({ chrome: fakeChrome(routes), transport: fakeDhl({}) });
  t.after(() => world.cleanup());
  assert.equal(await world.run("accounts", "add", "Personal", "--accept-risk"), 0);
  assert.equal(await world.run("login", "amazon:Personal"), 0);
  const key = `amazon:${ORDER}#0`;
  await dismiss(world, key);

  routes.trackers[`${ORDER}#0`] = tracker("Lieferung heute");
  world.setClock("2026-09-30T08:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);
  const reworded = await world.shipment(key);
  assert.equal(reworded.estimate.text, "Lieferung heute");
  assert.notEqual(reworded.dismissedAt ?? null, null);

  routes.trackers[`${ORDER}#0`] = tracker("Lieferung heute", 3);
  world.setClock("2026-09-30T11:00:00.000Z");
  assert.equal(await world.run("refresh"), 0);
  assert.equal(await dismissedAt(world, key), null);
});
