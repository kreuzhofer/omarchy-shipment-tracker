// When the plugin refreshes by itself (#79): on opening the popup with a
// stale or offline list, and once after a resume. Loads plugin/Freshness.js
// as the QML engine does (a plain script once `.pragma library` is gone).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../plugin/Freshness.js", import.meta.url), "utf8").replace(".pragma library", "");
const F = vm.runInNewContext(`${source}\n;({ stale, shouldRefresh, wokeUp, WAKE_DELAY_MS })`, {});

const NOW = Date.parse("2026-09-29T09:52:36Z");
const MIN = 60000;
const ago = (minutes) => new Date(NOW - minutes * MIN).toISOString();
const online = (minutes) => ({ lastRun: ago(minutes), lastOnline: ago(minutes), offline: false });

test("a list is stale when the last run that got through is over 65 minutes old, or the last run was offline", () => {
  assert.equal(F.stale(online(20), NOW), false);
  assert.equal(F.stale(online(65), NOW), false);
  assert.equal(F.stale(online(66), NOW), true);
  // The wake-up case: the catch-up run just ran, but offline.
  assert.equal(F.stale({ lastRun: ago(0.5), lastOnline: ago(171), offline: true }, NOW), true);
  assert.equal(F.stale({ lastRun: ago(2), lastOnline: ago(40), offline: true }, NOW), true);
  // Never ran, or no sources.json yet.
  assert.equal(F.stale({ lastRun: null }, NOW), true);
  assert.equal(F.stale(null, NOW), true);
  // Written before lastOnline existed.
  assert.equal(F.stale({ lastRun: ago(10) }, NOW), false);
});

test("opening the popup refreshes a stale list at most once per 5 minutes, and never while a refresh runs", () => {
  const stale = online(90);
  assert.equal(F.shouldRefresh(stale, NOW, 0, false), true);
  assert.equal(F.shouldRefresh(stale, NOW, 0, true), false);
  assert.equal(F.shouldRefresh(stale, NOW, NOW - 4 * MIN, false), false);
  assert.equal(F.shouldRefresh(stale, NOW, NOW - 5 * MIN, false), true);
  assert.equal(F.shouldRefresh(online(10), NOW, 0, false), false);
});

test("a wall-clock jump of more than 10 minutes between minute ticks is a resume", () => {
  assert.equal(F.wokeUp(NOW - MIN, NOW, MIN), false);
  assert.equal(F.wokeUp(NOW - 5 * MIN, NOW, MIN), false);
  assert.equal(F.wokeUp(NOW - 11 * MIN, NOW, MIN), false);
  assert.equal(F.wokeUp(NOW - 12 * MIN, NOW, MIN), true);
  assert.equal(F.wokeUp(NOW - 171 * MIN, NOW, MIN), true);
  // No tick yet.
  assert.equal(F.wokeUp(0, NOW, MIN), false);
  assert.equal(F.WAKE_DELAY_MS, 30000);
});
