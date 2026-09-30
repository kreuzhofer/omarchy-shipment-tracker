// The popup's live tour data (#80, variant B) and the notification toggle.
// Loads plugin/Shipments.js and plugin/Notify.js as the QML engine does
// (plain scripts once `.pragma library` / `.import` are gone) and checks their
// pure functions on synthetic rows.
process.env.TZ = "Europe/Berlin";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (name) => readFileSync(new URL(`../plugin/${name}`, import.meta.url), "utf8")
  .replace(".pragma library", "").replace(/^\.import .*$/m, "");
const S = vm.runInNewContext(`${read("Shipments.js")}\n;({ liveOf, stopsChip, tourDriven, etaText, dateLine, statusGlyph })`, {});
const N = vm.runInNewContext(`${read("Notify.js")}\n;({ pending, command })`, { Shipments: S });

// Arrays from the script's own realm, as plain ones.
const plain = (x) => JSON.parse(JSON.stringify(x));
const plainPending = (...args) => plain(N.pending(...args));

const NOW = Date.parse("2026-09-29T11:05:00Z");

const out = (live, extra = {}) => ({
  key: "dhl:00340434000000000801", direction: "Incoming", source: "DHL", carrier: "DHL", title: "Beispiel Shop GmbH",
  status: "Out for delivery", estimate: { from: "2026-09-29", to: "2026-09-29", text: "Tue 29 Sep" },
  changedAt: "2026-09-29T10:47:00.000Z", live, ...extra,
});
const live = (o) => ({ stops: null, bucket: null, remaining: null, eta: null, samples: [], ...o });

test("the stops chip: the exact count first, else the bucket, else nothing", () => {
  assert.equal(S.stopsChip(live({ stops: 3 })), "3 stops");
  assert.equal(S.stopsChip(live({ stops: 1 })), "Next stop");
  assert.equal(S.stopsChip(live({ bucket: "20+" })), "20+ stops");
  assert.equal(S.stopsChip(live({ bucket: "~10" })), "~10 stops");
  assert.equal(S.stopsChip(live({ bucket: "2" })), "2 stops");
  assert.equal(S.stopsChip(live({ bucket: "next" })), "Next stop");
  assert.equal(S.stopsChip(live({ remaining: 0.4 })), "");
  assert.equal(S.stopsChip(null), "");
});

test("live counts only on an Out for delivery card", () => {
  assert.ok(S.liveOf(out(live({ stops: 3 }))));
  assert.equal(S.liveOf(out(live({ stops: 3 }), { status: "Delivered" })), null);
  assert.equal(S.liveOf(out(undefined)), null);
});

test("step 4 fills with the share of the tour driven, 1 − remaining", () => {
  assert.equal(S.tourDriven(live({ remaining: 0.957 })).toFixed(3), "0.043");
  assert.equal(S.tourDriven(live({ remaining: 0 })), 1);
  assert.equal(S.tourDriven(live({ remaining: null })), -1);
  assert.equal(S.tourDriven(null), -1);
});

test("the right-hand line: the estimated arrival and the age when there is one, else the Estimate", () => {
  const eta = live({ bucket: "2", eta: "2026-09-29T11:20:00.000Z" });
  assert.equal(S.etaText(eta), "≈ 13:20 est.");
  assert.equal(S.dateLine(out(eta), NOW), "≈ 13:20 est.  ·  18 min ago");
  assert.equal(S.dateLine(out(live({ bucket: "20+" })), NOW), "Today  ·  18 min ago");
  assert.equal(S.dateLine(out(undefined), NOW), "Today  ·  18 min ago");
});

test("notifications off: the fresh events are claimed but none is sent, and turning them on replays nothing", () => {
  const almost = { id: 7, kind: "almost", key: "dhl:x", status: "Out for delivery", title: "Almost there: parcel from Beispiel Shop GmbH", body: "Your parcel from Beispiel Shop GmbH is the next stop", url: "https://example.invalid/x" };
  assert.deepEqual(plainPending({ events: [], lastEventId: 6 }, true), []); // first read records the id
  assert.deepEqual(plainPending({ events: [almost], lastEventId: 7 }, false), []);
  assert.deepEqual(plainPending({ events: [almost], lastEventId: 7 }, true), []);
  const next = { ...almost, id: 8 };
  assert.deepEqual(plainPending({ events: [next], lastEventId: 8 }, true).map((e) => e.id), [8]);
});

test("an almost there notification shows the cached product image, else the Out for delivery glyph", () => {
  const e = { id: 1, kind: "almost", status: "Out for delivery", title: "Arriving soon: USB-C Dock", body: "Your USB-C Dock arrives in ~15 min (around 13:20)", url: "https://example.invalid/x" };
  const withImage = N.command({ ...e, image: "/tmp/dock.jpg" }, "");
  assert.deepEqual(plain(withImage.slice(5, 7)), ["--image", "/tmp/dock.jpg"]);
  const plainCmd = N.command(e, "");
  assert.deepEqual(plain(plainCmd.slice(5, 7)), ["-g", S.statusGlyph("Out for delivery")]);
  assert.deepEqual(plain(plainCmd.slice(7, 9)), [e.title, e.body]);
});
