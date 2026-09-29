// The popup's presentation of finished Shipments (#76). The plugin has no
// test seam of its own: this loads plugin/Shipments.js as the QML engine does
// (a plain script once `.pragma library` is gone) and checks its pure
// functions on synthetic rows from every Source.
process.env.TZ = "Europe/Berlin";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../plugin/Shipments.js", import.meta.url), "utf8").replace(".pragma library", "");
const S = vm.runInNewContext(`${source}\n;({ byUrgency, dateLine, statusLine, inWindow, pendingCount, settled, terminalDay })`, {});

const NOW = Date.parse("2026-09-29T10:00:00Z");
const TODAY = "2026-09-29T08:00:00.000Z"; // what today's merges and migrations left in changedAt

const dhl = (key, day, extra = {}) => ({
  key: `dhl:${key}`, direction: "Incoming", source: "DHL", carrier: "DHL", title: key, status: "Delivered",
  estimate: { from: day, to: day, text: `Delivered …` }, changedAt: TODAY, terminalAt: TODAY, ...extra,
});
const amazon = (key, day, text) => ({
  key: `amazon:${key}#0`, direction: "Incoming", source: "Amazon", account: "Personal", title: key, status: "Delivered",
  estimate: { from: day, to: day, text }, changedAt: TODAY, terminalAt: TODAY,
});
const mailOrder = (key, step, at, estimate = null) => ({
  key: `amazon:${key}`, direction: "Incoming", source: "Amazon", account: null, connections: ["mail"], title: key,
  status: "Unknown", estimate, mail: { step, at, estimate: null }, hint: `${step} · per mail, 1 Sep`, changedAt: TODAY,
});
const moving = (key, status, changedAt) => ({
  key: `dhl:${key}`, direction: "Incoming", source: "DHL", carrier: "DHL", title: key, status,
  estimate: { from: "2026-09-30", to: "2026-09-30", text: "Wed 30 Sep" }, changedAt,
});

test("a Terminal card's date line is one wording for every Source, without an age", () => {
  assert.equal(S.dateLine(dhl("D1", "2026-09-28"), NOW), "Delivered Mon 28 Sep");
  assert.equal(S.dateLine(amazon("A1", "2026-09-09", "Zugestellt: 9. September"), NOW), "Delivered Wed 9 Sep");
  assert.equal(S.dateLine({ ...dhl("R1", "2026-09-21"), status: "Returned" }, NOW), "Returned Mon 21 Sep");
  // No reported day: the day it was first seen Terminal, in local time.
  assert.equal(S.dateLine({ ...dhl("D2", null), estimate: null, terminalAt: "2026-09-27T22:30:00.000Z" }, NOW),
    "Delivered Mon 28 Sep");
});

test("the mail hint writes its day like every other date line, and a delivered one has no second date", () => {
  const delivered = mailOrder("M1", "Delivered", "2026-09-01T07:00:00.000Z");
  assert.equal(S.statusLine(delivered), "\u{F01F0}  Delivered · per mail, Tue 1 Sep");
  assert.equal(S.dateLine(delivered, NOW), "");
  const shipped = mailOrder("M2", "Shipped", "2026-09-01T07:00:00.000Z", { from: "2026-10-02", to: "2026-10-02", text: "Fri 2 Oct" });
  assert.equal(S.statusLine(shipped), "\u{F01F0}  Shipped · per mail, Tue 1 Sep");
  assert.equal(S.dateLine(shipped, NOW), "Fri 2 Oct  ·  2 h ago");
  assert.equal(S.statusLine({ ...shipped, hint: "Status unknown" }), "\u{F01F0}  Status unknown");
});

test("non-Terminal cards keep the Estimate and the age of their last change", () => {
  assert.equal(S.dateLine(moving("T1", "In transit", "2026-09-28T10:00:00.000Z"), NOW), "Tomorrow  ·  1 d ago");
});

test("finished rows sort below the others by delivery day, delivered-per-mail ones among them", () => {
  const rows = [
    dhl("D-jul", "2026-07-20"),
    mailOrder("M-sep1", "Delivered", "2026-09-01T07:00:00.000Z"),
    amazon("A-sep9", "2026-09-09", "Zugestellt: 9. September"),
    moving("T-old", "In transit", "2026-09-20T10:00:00.000Z"),
    dhl("D-sep28", "2026-09-28"),
    mailOrder("M-shipped", "Shipped", "2026-09-27T07:00:00.000Z"),
    { ...amazon("A-ret", "2026-09-15", "Rückgabe erhalten"), status: "Returned" },
    moving("T-new", "Out for delivery", "2026-09-29T06:00:00.000Z"),
  ];
  assert.deepEqual(rows.sort(S.byUrgency).map((s) => s.title), [
    "T-new", "T-old", "M-shipped", "D-sep28", "A-ret", "A-sep9", "M-sep1", "D-jul",
  ]);
});

test("the 7 / 30 days window takes finished rows by delivery day, others by last change", () => {
  const rows = [
    dhl("D-jul", "2026-07-20"),
    amazon("A-sep9", "2026-09-09", "Zugestellt: 9. September"),
    dhl("D-sep28", "2026-09-28"),
    dhl("D-sep22", "2026-09-22"),
    mailOrder("M-sep1", "Delivered", "2026-09-01T07:00:00.000Z"),
    mailOrder("M-sep25", "Delivered", "2026-09-25T07:00:00.000Z"),
    moving("T-old", "In transit", "2026-09-10T10:00:00.000Z"),
    moving("T-new", "In transit", "2026-09-28T10:00:00.000Z"),
    { key: "queued:X", status: "Unknown", changedAt: "2026-08-01T00:00:00.000Z" },
  ];
  const shown = (days) => rows.filter((s) => S.inWindow(s, days, NOW)).map((s) => s.title ?? s.key);
  assert.deepEqual(shown(7), ["D-sep28", "D-sep22", "M-sep25", "T-new", "queued:X"]);
  assert.deepEqual(shown(30), ["A-sep9", "D-sep28", "D-sep22", "M-sep1", "M-sep25", "T-old", "T-new", "queued:X"]);
});

test("the tab count leaves out finished rows, delivered-per-mail ones too", () => {
  const rows = [
    dhl("D1", "2026-09-28"),
    amazon("A1", "2026-09-09", "Zugestellt: 9. September"),
    mailOrder("M-del", "Delivered", "2026-09-25T07:00:00.000Z"),
    mailOrder("M-shipped", "Shipped", "2026-09-27T07:00:00.000Z"),
    moving("T1", "In transit", TODAY),
    { ...moving("T2", "Announced", TODAY), dismissed: true },
  ];
  assert.equal(S.pendingCount("Incoming", rows), 2);
  // Mail never decides a Status: the row stays Unknown.
  assert.equal(rows[2].status, "Unknown");
  assert.equal(S.settled(rows[2]), true);
});
