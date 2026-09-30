// Close to a delivery (#80) at the refresh seam: DHL's live tour data on an
// Out for delivery Shipment (`sendungsdetails.liveTracking`, authenticated
// enrichment only), the 15-min `refresh --source dhl --if-close` run, its
// timer, and the one "almost there" notification. The liveTracking fixtures
// are synthetic, modelled on the field names and shapes seen live in #80
// (countdownTextKey CD20 → CD10 → CD02 → CD01, countdown near the end,
// distance falling from ~1 to 0, coordinates alongside, empty on delivery).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeDhlAccount, fixture, makeWorld } from "./harness.mjs";

const A = "00340434000000000801";
const B = "00340434000000000802";

// Synthetic coordinates; the test checks none of this ever reaches a file.
const COORDS = { tourCoords: { lat: 1.2345671, lng: 2.3456781 }, destinationCoords: { lat: 1.2399991, lng: 2.3499991 } };

// liveTracking as DHL sends it: { key, countdown, distance } → the element field.
function liveTracking({ key = null, countdown = null, distance = null } = {}) {
  return {
    ...(key ? { countdownTextKey: key } : {}),
    ...(countdown !== null ? { countdown } : {}),
    ...(distance !== null ? { distance } : {}),
    ...COORDS,
    state: "reduced",
    deliveryType: "PAKET",
  };
}

// parcel(id, status, { live, window, direction })
function parcel(id, status, { live = undefined, window = null, direction = "Incoming", title = "Beispiel Shop GmbH" } = {}) {
  const e = structuredClone(fixture("dhl/account/enriched.json").sendungen[0]);
  e.id = id;
  e.sendungsinfo.gesuchteSendungsnummer = id;
  e.sendungsinfo.sendungsname = title;
  e.sendungsinfo.sendungsrichtung = direction === "Outgoing" ? "ABGEHEND" : "ANKOMMEND";
  const d = e.sendungsdetails;
  d.sendungsnummern.sendungsnummer = id;
  if (direction === "Outgoing") d.empfaenger = { name: title };
  const v = d.sendungsverlauf;
  if (status === "Out for delivery") v.fortschritt = 4;
  if (status === "Delivered") {
    d.istZugestellt = true;
    v.fortschritt = 5;
    v.status = "Zustellung erfolgreich.";
  }
  if (window) [d.zustellung.zustellzeitfensterVon, d.zustellung.zustellzeitfensterBis] = window;
  if (live !== undefined) d.liveTracking = live;
  return e;
}

function account(list) {
  const dhl = fakeDhlAccount({});
  dhl.searches = 0;
  dhl.show = (elements) => {
    const r = { json: { sendungen: elements, mergedAnonymousShipmentListIds: [], rateLimited: false } };
    dhl.inbox = r;
    dhl.enrich = () => r;
  };
  const fetch = dhl.fetch.bind(dhl);
  dhl.requests = 0;
  dhl.fetch = (...args) => { dhl.requests++; return fetch(...args); };
  dhl.show(list);
  return dhl;
}

// Logged in at 12:00 Berlin with `first` as the Sendungsliste.
async function connected(t, first) {
  const dhl = account(first);
  const world = await makeWorld({ transport: dhl });
  t.after(() => world.cleanup());
  assert.equal(await world.run("login", "dhl"), 0);
  return { world, dhl };
}

// A run at `at` (UTC) with `list` as the Sendungsliste.
async function runAt(world, dhl, at, list, ...args) {
  dhl.show(list);
  world.setClock(at);
  assert.equal(await world.run("refresh", ...args), 0);
  return world.shipmentsFile();
}

const liveOf = async (world, id = A) => (await world.shipment(`dhl:${id}`)).live;

// ---- Parsing

for (const [key, bucket] of [["CD20", "20+"], ["CD10", "~10"], ["CD02", "2"], ["CD01", "next"], ["CD05", "~5"], ["CD03", "~3"]]) {
  test(`countdownTextKey ${key} is the bucket "${bucket}" when there is no exact count`, async (t) => {
    const { world } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key, distance: 0.5 }) })]);

    const live = await liveOf(world);
    assert.equal(live.stops, null);
    assert.equal(live.bucket, bucket);
    assert.equal(live.remaining, 0.5);
  });
}

test("a stop code that isn't CDnn is no bucket: nothing is invented", async (t) => {
  const { world } = await connected(t, [
    parcel(A, "Out for delivery", { live: liveTracking({ key: "CDXX", distance: 0.4 }) }),
    parcel(B, "Out for delivery", { live: liveTracking({ key: "CD00" }) }),
  ]);

  assert.deepEqual(await liveOf(world), { stops: null, bucket: null, remaining: 0.4, eta: null, samples: [{ at: "2026-09-29T10:00:00.000Z", remaining: 0.4 }] });
  // Nothing usable at all: no live.
  assert.equal(await liveOf(world, B), undefined);
});

test("the exact countdown wins over the bucket", async (t) => {
  const { world } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD02", countdown: 3, distance: 0.09 }) })]);

  const live = await liveOf(world);
  assert.equal(live.stops, 3);
  assert.equal(live.bucket, null);
  assert.equal(live.remaining, 0.09);
});

test("DHL's coordinates are never stored", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD10", distance: 0.5 }) })]);
  await runAt(world, dhl, "2026-09-29T10:15:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD02", countdown: 4, distance: 0.4 }) })]);

  for (const file of ["shipments.json", "sources.json"]) {
    const text = await readFile(join(world.stateDir, file), "utf8");
    assert.doesNotMatch(text, /Coords|lat|lng|1\.23|2\.34|reduced|deliveryType/, file);
  }
  assert.deepEqual(Object.keys(await liveOf(world)).sort(), ["bucket", "eta", "remaining", "samples", "stops"]);
});

test("a Shipment that isn't Out for delivery keeps no live data, whatever DHL sends", async (t) => {
  const { world } = await connected(t, [parcel(A, "In transit", { live: liveTracking({ key: "CD20", distance: 0.9 }) })]);

  assert.equal(await liveOf(world), undefined);
});

// ---- Estimated arrival

test("the ETA needs two samples and a falling trend; it is when the tour's remaining share reaches 0", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD10", distance: 0.5 }) })]);
  // One sample: no ETA.
  assert.equal((await liveOf(world)).eta, null);

  // 0.5 → 0.4 in 15 min: 0.4 more takes 60 min, from 10:15Z.
  await runAt(world, dhl, "2026-09-29T10:15:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD10", distance: 0.4 }) })]);
  const live = await liveOf(world);
  assert.equal(live.eta, "2026-09-29T11:15:00.000Z");
  assert.deepEqual(live.samples, [
    { at: "2026-09-29T10:00:00.000Z", remaining: 0.5 },
    { at: "2026-09-29T10:15:00.000Z", remaining: 0.4 },
  ]);
});

test("no ETA while the remaining share rises or stands still", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD10", distance: 0.4 }) })]);

  await runAt(world, dhl, "2026-09-29T10:15:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD10", distance: 0.45 }) })]);
  assert.equal((await liveOf(world)).eta, null);
  await runAt(world, dhl, "2026-09-29T10:30:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD10", distance: 0.45 }) })]);
  await runAt(world, dhl, "2026-09-29T10:45:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD10", distance: 0.45 }) })]);
  assert.equal((await liveOf(world)).eta, null);
});

test("no ETA that would fall after today; never one before now", async (t) => {
  // Crawling: 0.9 → 0.89 in 15 min would take until tomorrow.
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20", distance: 0.9 }) })]);
  await runAt(world, dhl, "2026-09-29T10:15:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20", distance: 0.89 }) })]);
  assert.equal((await liveOf(world)).eta, null);

  // Almost done: the line reaches 0 already; the ETA is now.
  await runAt(world, dhl, "2026-09-29T10:30:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD01", distance: 0 }) })]);
  const live = await liveOf(world);
  assert.equal(live.eta, "2026-09-29T10:30:00.000Z");
});

test("at most six samples, all of today's tour", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20", distance: 0.95 }) })]);
  for (let i = 1; i <= 7; i++) {
    const at = new Date(Date.parse("2026-09-29T10:00:00.000Z") + i * 15 * 60_000).toISOString();
    await runAt(world, dhl, at, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20", distance: 0.95 - i * 0.1 }) })]);
  }
  const live = await liveOf(world);
  assert.equal(live.samples.length, 6);
  assert.equal(live.samples[0].at, "2026-09-29T10:30:00.000Z");

  // Still Out for delivery the next morning: yesterday's samples are gone.
  await runAt(world, dhl, "2026-09-30T06:00:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20", distance: 0.99 }) })]);
  assert.deepEqual((await liveOf(world)).samples, [{ at: "2026-09-30T06:00:00.000Z", remaining: 0.99 }]);
  assert.equal((await liveOf(world)).eta, null);
});

// ---- Leaving Out for delivery

test("live is cleared on delivery, when liveTracking comes back empty", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD02", countdown: 3, distance: 0.09 }) })]);
  assert.ok(await liveOf(world));

  await runAt(world, dhl, "2026-09-29T11:20:00.000Z", [parcel(A, "Delivered", { live: {} })]);
  const s = await world.shipment(`dhl:${A}`);
  assert.equal(s.status, "Delivered");
  assert.equal("live" in s, false);
});

test("live is cleared when DHL stops sending it while still Out for delivery", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD10", distance: 0.5 }) })]);

  await runAt(world, dhl, "2026-09-29T10:15:00.000Z", [parcel(A, "Out for delivery", { live: {} })]);
  assert.equal(await liveOf(world), undefined);
});

// ---- No events, no updates from live changes

test("changes of live create no events, move no changedAt and bring back no Dismissed Shipment", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20", distance: 0.95 }) })]);
  const before = await world.shipment(`dhl:${A}`);
  assert.equal(await world.run("dismiss", `dhl:${A}`), 0);

  for (const [at, distance] of [["2026-09-29T10:15:00.000Z", 0.8], ["2026-09-29T10:30:00.000Z", 0.7], ["2026-09-29T10:45:00.000Z", 0.6]]) {
    const file = await runAt(world, dhl, at, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20", distance }) })]);
    assert.deepEqual(file.events, []);
  }
  const after = await world.shipment(`dhl:${A}`);
  assert.equal(after.changedAt, before.changedAt);
  assert.ok(after.dismissedAt, "still Dismissed");
  assert.ok(after.live.eta, "the ETA changed along the way");
});

// ---- The 15-min run

test("--if-close does nothing, without a request, when no DHL Shipment is close", async (t) => {
  const { world, dhl } = await connected(t, [
    parcel(A, "In transit", { window: ["2026-09-30", "2026-09-30"] }),
    parcel(B, "Delivered"),
  ]);
  const before = await world.shipmentsFile();
  const sourcesBefore = await world.sourcesFile();
  dhl.requests = 0;

  assert.equal(await world.run("refresh", "--source", "dhl", "--if-close"), 0);

  assert.equal(dhl.requests, 0);
  assert.deepEqual(await world.shipmentsFile(), before);
  assert.deepEqual(await world.sourcesFile(), sourcesBefore);
});

test("--if-close does nothing without a DHL login", async (t) => {
  const dhl = account([]);
  const world = await makeWorld({ transport: dhl });
  t.after(() => world.cleanup());

  assert.equal(await world.run("refresh", "--source", "dhl", "--if-close"), 0);
  assert.equal(dhl.requests, 0);
});

test("--if-close syncs DHL while a Shipment is Out for delivery, renewing the token like the hourly run", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20", distance: 0.9 }) })]);
  const tokenBefore = (await world.tokenFile()).refresh_token;

  const file = await runAt(world, dhl, "2026-09-29T10:15:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD10", distance: 0.7 }) })], "--source", "dhl", "--if-close");

  assert.equal(file.shipments[0].live.bucket, "~10");
  assert.notEqual((await world.tokenFile()).refresh_token, tokenBefore);
  assert.equal((await world.sourcesFile()).connections.dhl.lastOk, "2026-09-29T10:15:00.000Z");
});

test("--if-close syncs DHL when a Shipment's delivery window is today, and its events come with it", async (t) => {
  // The window is Tue 29 Sep; it is 12:15 Berlin on the 29th.
  const { world, dhl } = await connected(t, [parcel(A, "In transit", { window: ["2026-09-29", "2026-09-29"] })]);

  const file = await runAt(world, dhl, "2026-09-29T10:15:00.000Z", [parcel(A, "Delivered", { live: {} })], "--source", "dhl", "--if-close");

  assert.equal(file.shipments[0].status, "Delivered");
  assert.deepEqual(file.events.map((e) => e.kind), ["status"]);
});

test("--if-close skips while another run is in flight", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20", distance: 0.9 }) })]);
  const sources = await world.sourcesFile();
  sources.refreshing = { startedAt: "2026-09-29T10:10:00.000Z" };
  await writeFile(join(world.stateDir, "sources.json"), JSON.stringify(sources));
  dhl.requests = 0;

  world.setClock("2026-09-29T10:15:00.000Z");
  assert.equal(await world.run("refresh", "--source", "dhl", "--if-close"), 0);
  assert.equal(dhl.requests, 0);
});

test("--if-close only goes with --source dhl", async (t) => {
  const world = await makeWorld();
  t.after(() => world.cleanup());

  assert.equal(await world.run("refresh", "--if-close"), 2);
  assert.equal(await world.run("refresh", "--source", "mail", "--if-close"), 2);
});

test("install writes and enables the 15-min timer next to the hourly one; uninstall removes both", async (t) => {
  const world = await makeWorld();
  t.after(() => world.cleanup());
  const dir = join(world.env.XDG_CONFIG_HOME, "systemd/user");

  assert.equal(await world.run("install"), 0);
  const timer = await readFile(join(dir, "shipment-tracker-refresh-close.timer"), "utf8");
  assert.match(timer, /^OnCalendar=\*:0\/15$/m);
  const service = await readFile(join(dir, "shipment-tracker-refresh-close.service"), "utf8");
  assert.match(service, /^ExecStart=.* refresh --source dhl --if-close$/m);
  assert.deepEqual(world.systemctl.filter((a) => a[0] === "enable"), [
    ["enable", "--now", "shipment-tracker-refresh.timer"],
    ["enable", "--now", "shipment-tracker-refresh-close.timer"],
  ]);

  // Idempotent.
  world.systemctl.length = 0;
  assert.equal(await world.run("install"), 0);
  assert.equal(world.systemctl.some((a) => a[0] === "daemon-reload"), false);

  assert.equal(await world.run("uninstall"), 0);
  assert.deepEqual(world.systemctl.filter((a) => a[0] === "disable"), [
    ["disable", "--now", "shipment-tracker-refresh.timer"],
    ["disable", "--now", "shipment-tracker-refresh-close.timer"],
  ]);
  for (const name of ["shipment-tracker-refresh-close.timer", "shipment-tracker-refresh-close.service", "shipment-tracker-refresh.timer"]) {
    assert.equal(await world.exists(join(dir, name)), false, name);
  }
});

// ---- "Almost there"

const almost = (events) => events.filter((e) => e.kind === "almost");

test("almost there, with an ETA: when and in how many minutes", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20", distance: 0.5 }) })]);

  // 0.5 → 0.4 in 15 min: arrival at 11:15Z, 60 min from now (13:15 Berlin).
  const file = await runAt(world, dhl, "2026-09-29T10:15:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD10", distance: 0.4 }) })]);

  assert.deepEqual(file.events.map((e) => ({ ...e, id: 0 })), [{
    id: 0,
    kind: "almost",
    key: `dhl:${A}`,
    status: "Out for delivery",
    title: "Arriving soon: parcel from Beispiel Shop GmbH",
    body: "Your parcel from Beispiel Shop GmbH arrives in ~60 min (around 13:15)",
    url: `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${A}`,
  }]);
});

for (const [live, phrase] of [
  [{ key: "CD10" }, "is about 10 stops away"],
  [{ key: "CD02", countdown: 4 }, "is 4 stops away"],
  [{ key: "CD02" }, "is 2 stops away"],
  [{ key: "CD01" }, "is the next stop"],
  [{ key: "CD02", countdown: 1 }, "is the next stop"],
]) {
  test(`almost there, without an ETA: "${phrase}"`, async (t) => {
    const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20" }) })]);

    const file = await runAt(world, dhl, "2026-09-29T10:15:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking(live) })]);

    assert.deepEqual(almost(file.events).map((e) => [e.title, e.body]), [
      ["Almost there: parcel from Beispiel Shop GmbH", `Your parcel from Beispiel Shop GmbH ${phrase}`],
    ]);
  });
}

test("almost there waits for 10 stops or fewer: CD20 and an exact 11 don't fire, CD10 does", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20" }) })]);

  assert.deepEqual((await runAt(world, dhl, "2026-09-29T10:15:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20" }) })])).events, []);
  assert.deepEqual((await runAt(world, dhl, "2026-09-29T10:30:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20", countdown: 11 }) })])).events, []);
  assert.deepEqual(almost((await runAt(world, dhl, "2026-09-29T10:45:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD10" }) })])).events).length, 1);
});

test("almost there fires once per Shipment, also across runs that come closer and a later tour", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20" }) })]);

  const counts = [];
  for (const [at, live] of [
    ["2026-09-29T10:15:00.000Z", { key: "CD10" }],
    ["2026-09-29T10:30:00.000Z", { key: "CD02", countdown: 3 }],
    ["2026-09-29T10:45:00.000Z", { key: "CD01" }],
  ]) {
    counts.push(almost((await runAt(world, dhl, at, [parcel(A, "Out for delivery", { live: liveTracking(live) })])).events).length);
  }
  assert.deepEqual(counts, [1, 0, 0]);
  assert.equal((await world.shipment(`dhl:${A}`)).almostNotified, true);

  // Not delivered today; out again tomorrow: still not again.
  await runAt(world, dhl, "2026-09-29T17:00:00.000Z", [parcel(A, "In transit")]);
  await runAt(world, dhl, "2026-09-30T08:00:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20" }) })]);
  const file = await runAt(world, dhl, "2026-09-30T09:00:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD02" }) })]);
  assert.deepEqual(almost(file.events), []);
});

test("almost there is for Incoming Shipments only", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { direction: "Outgoing", live: liveTracking({ key: "CD20" }) })]);

  const file = await runAt(world, dhl, "2026-09-29T10:15:00.000Z", [parcel(A, "Out for delivery", { direction: "Outgoing", live: liveTracking({ key: "CD01" }) })]);
  assert.deepEqual(file.events, []);
});

test("a Shipment that turns Out for delivery already close tells that first, and almost there on the next run", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "In transit")]);

  const first = await runAt(world, dhl, "2026-09-29T10:15:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD02" }) })]);
  assert.deepEqual(first.events.map((e) => e.kind), ["status"]);
  const next = await runAt(world, dhl, "2026-09-29T10:30:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD02" }) })], "--source", "dhl", "--if-close");
  assert.deepEqual(next.events.map((e) => e.kind), ["almost"]);
});

test("a Dismissed Shipment still gets almost there, and stays Dismissed", async (t) => {
  const { world, dhl } = await connected(t, [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD20" }) })]);
  assert.equal(await world.run("dismiss", `dhl:${A}`), 0);

  const file = await runAt(world, dhl, "2026-09-29T10:15:00.000Z", [parcel(A, "Out for delivery", { live: liveTracking({ key: "CD10" }) })]);
  assert.equal(almost(file.events).length, 1);
  assert.ok((await world.shipment(`dhl:${A}`)).dismissedAt);
});
