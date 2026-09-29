// One refresh run: the only writer of Status, Health and events[].
//
// Run order (spec #21): the DHL Connection (when logged in), then anonymous
// lookups of the DHL numbers the Sendungsliste didn't list (manual adds and
// numbers learned from Amazon), then each Amazon account, then lookups of DHL
// numbers Amazon showed for the first time. Each number is looked up at most
// once per run. `source` limits the run to one Connection key ("dhl" or
// "amazon:<label>", for Retry); lookups then wait for the next full run.
//
// Network requests happen outside the state lock; their results are applied
// under it, re-reading the files first so a concurrent `add` is never lost.
// A Shipment added while a run is in flight is picked up by the next round of
// the same run.
//
// Notification events: every Shipment that has been read gets its mark at the
// start (markKnown), and the run's events are recorded once at the end, after
// every Connection, so the >3 collapse sees the whole run (see events.mjs).
import { refreshAmazon } from "./amazon/connection.mjs";
import { hasTokens } from "./dhl/auth.mjs";
import { applyDhlSync, KEY as DHL, syncDhl } from "./dhl/connection.mjs";
import { lookupAnonymous } from "./dhl/search.mjs";
import { readDhlElement } from "./dhl/status.mjs";
import { firstSyncConnections, markKnown, recordEvents } from "./events.mjs";
import { applyDhlReading, carriedByDhl } from "./merge.mjs";
import { TERMINAL } from "./shipments.mjs";
import { readState, updateState } from "./state.mjs";

const MAX_ROUNDS = 3;

// Manual DHL adds and DHL numbers learned from Amazon are looked up
// anonymously, one request per number per run. Terminal Shipments are never
// re-fetched.
const needsLookup = (s) => !TERMINAL.has(s.status)
  && ((s.source === "DHL" && s.connections.includes("manual")) || carriedByDhl(s));

// `firstSync`: this run is the first sync of the `source` Connection after a
// Login, so what it discovers is not announced as new.
export async function refresh({ stateDir, env, now, transport, chrome, sleep, timeZone, log, source = null, firstSync = false }) {
  const attempted = new Set();
  const counts = { lookedUp: 0, unknown: 0, failed: 0, network: 0, synced: 0 };
  // Called by every part of the run that got to write its results.
  const finishRun = (sources, at) => {
    sources.lastRun = at.toISOString();
    // Offline is not an error: only the subtitle changes.
    sources.offline = counts.network > 0 && counts.network === counts.failed && counts.lookedUp === 0 && counts.synced === 0;
  };
  // The header reads "Refreshing…" while this is set.
  const quiet = await updateState(stateDir, ({ shipments, sources }) => {
    sources.refreshing = { startedAt: now().toISOString() };
    markKnown(shipments);
    return firstSyncConnections(sources);
  });
  if (firstSync && source) quiet.add(source);

  if ((source === null || source === DHL) && await hasTokens(stateDir)) {
    const outcome = await syncDhl({ stateDir, transport, now });
    if (outcome.ok) counts.synced++;
    else {
      counts.failed++;
      if (outcome.reason === "network") counts.network++;
    }
    const listed = await updateState(stateDir, (state) => {
      const at = now();
      const keys = applyDhlSync(state, outcome, at);
      finishRun(state.sources, at);
      return keys;
    });
    // The Sendungsliste already told us about these; no anonymous lookup.
    for (const trackingNumber of listed) attempted.add(trackingNumber);
    log(outcome.ok ? `refresh: dhl ok, ${outcome.elements.length} listed` : `refresh: dhl failed (${outcome.reason})`);
  }

  // Anonymous lookups; the pass `afterAmazon` does nothing unless Amazon showed
  // a DHL number not yet looked up this run.
  const lookUp = async ({ afterAmazon = false } = {}) => {
    for (let round = 0; round < (source === null ? MAX_ROUNDS : 0); round++) {
      const snapshot = await readState(stateDir);
      const targets = [...new Set(snapshot.shipments.shipments
        .filter((s) => needsLookup(s) && !attempted.has(s.trackingNumber))
        .map((s) => s.trackingNumber))];
      if ((round > 0 || afterAmazon) && targets.length === 0) break;

      const readings = new Map();
      for (const trackingNumber of targets) {
        attempted.add(trackingNumber);
        const result = await lookupAnonymous(transport, trackingNumber);
        const reading = result.ok ? readDhlElement(result.element) : null;
        if (reading) {
          readings.set(trackingNumber, reading);
          counts.lookedUp++;
          if (reading.status === "Unknown") counts.unknown++;
        } else {
          counts.failed++;
          if (result.reason === "network") counts.network++;
        }
      }

      await updateState(stateDir, ({ shipments, sources }) => {
        const at = now();
        for (const s of shipments.shipments) {
          const reading = needsLookup(s) ? readings.get(s.trackingNumber) : undefined;
          if (reading) applyDhlReading(s, reading, at);
        }
        finishRun(sources, at);
      });
    }
  };
  await lookUp();

  if (source === null || source.startsWith("amazon:")) {
    await refreshAmazon({ stateDir, env, now, chrome, sleep, timeZone, log, counts, finishRun, only: source });
    await lookUp({ afterAmazon: true });
  }

  // "Refreshing…" lasts the whole run, Amazon's paced page reads included.
  const told = await updateState(stateDir, ({ shipments, sources }) => {
    sources.refreshing = null;
    return recordEvents(shipments, { firstSync: quiet });
  });
  if (told > 0) log(`refresh: ${told} notification event(s)`);

  log(`refresh: looked up ${counts.lookedUp} (${counts.unknown} unknown), ${counts.failed} failed${counts.network ? `, ${counts.network} offline` : ""}`);
  return 0;
}
