// One refresh run: the only writer of Status, Health and events[].
//
// Run order: the DHL Connection (when logged in), then anonymous lookups of
// manual adds the Sendungsliste didn't list. `source` limits the run to one
// Connection key (Retry); manual lookups then wait for the next full run.
//
// Network requests happen outside the state lock; their results are applied
// under it, re-reading the files first so a concurrent `add` is never lost.
// A Shipment added while a run is in flight is picked up by the next round of
// the same run.
import { hasTokens } from "./dhl/auth.mjs";
import { applyDhlSync, KEY as DHL, syncDhl } from "./dhl/connection.mjs";
import { lookupAnonymous } from "./dhl/search.mjs";
import { readDhlElement } from "./dhl/status.mjs";
import { applyReading, TERMINAL } from "./shipments.mjs";
import { readState, updateState } from "./state.mjs";

const MAX_ROUNDS = 3;

// Manual DHL adds are looked up anonymously, one request per number per run.
// Terminal Shipments are never re-fetched.
const needsLookup = (s) => s.source === "DHL" && s.connections.includes("manual") && !TERMINAL.has(s.status);

export async function refresh({ stateDir, now, transport, log, source = null }) {
  const attempted = new Set();
  const counts = { lookedUp: 0, unknown: 0, failed: 0, network: 0, synced: 0 };
  const finishRun = (sources, at) => {
    sources.lastRun = at.toISOString();
    sources.refreshing = null;
    // Offline is not an error: only the subtitle changes.
    sources.offline = counts.network > 0 && counts.network === counts.failed && counts.lookedUp === 0 && counts.synced === 0;
  };
  // The header reads "Refreshing…" while this is set.
  await updateState(stateDir, ({ sources }) => { sources.refreshing = { startedAt: now().toISOString() }; });

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
      state.shipments.events = [];
      finishRun(state.sources, at);
      return keys;
    });
    // The Sendungsliste already told us about these; no anonymous lookup.
    for (const key of listed) attempted.add(key);
    log(outcome.ok ? `refresh: dhl ok, ${outcome.elements.length} listed` : `refresh: dhl failed (${outcome.reason})`);
  }

  for (let round = 0; round < (source === null ? MAX_ROUNDS : 0); round++) {
    const snapshot = await readState(stateDir);
    const targets = snapshot.shipments.shipments.filter((s) => needsLookup(s) && !attempted.has(s.key));
    if (round > 0 && targets.length === 0) break;

    const readings = new Map();
    for (const s of targets) {
      attempted.add(s.key);
      const result = await lookupAnonymous(transport, s.trackingNumber);
      const reading = result.ok ? readDhlElement(result.element) : null;
      if (reading) {
        readings.set(s.key, reading);
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
        const reading = readings.get(s.key);
        if (reading) applyReading(s, reading, at);
      }
      shipments.events = [];
      finishRun(sources, at);
    });
  }

  log(`refresh: looked up ${counts.lookedUp} (${counts.unknown} unknown), ${counts.failed} failed${counts.network ? `, ${counts.network} offline` : ""}`);
  return 0;
}
