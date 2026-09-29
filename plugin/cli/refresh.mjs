// One refresh run: the only writer of Status, Health and events[].
//
// Network requests happen outside the state lock; their results are applied
// under it, re-reading the files first so a concurrent `add` is never lost.
// A Shipment added while a run is in flight is picked up by the next round of
// the same run.
import { lookupAnonymous } from "./dhl/search.mjs";
import { readDhlElement } from "./dhl/status.mjs";
import { applyReading, TERMINAL } from "./shipments.mjs";
import { readState, updateState } from "./state.mjs";

const MAX_ROUNDS = 3;

// Manual DHL adds are looked up anonymously, one request per number per run.
// Terminal Shipments are never re-fetched.
const needsLookup = (s) => s.source === "DHL" && s.connections.includes("manual") && !TERMINAL.has(s.status);

export async function refresh({ stateDir, now, transport, log }) {
  const attempted = new Set();
  const counts = { lookedUp: 0, unknown: 0, failed: 0, network: 0 };

  for (let round = 0; round < MAX_ROUNDS; round++) {
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
      sources.lastRun = at.toISOString();
      sources.refreshing = null;
      // Offline is not an error: only the subtitle changes.
      sources.offline = counts.network > 0 && counts.network === counts.failed && counts.lookedUp === 0;
    });
  }

  log(`refresh: looked up ${counts.lookedUp} (${counts.unknown} unknown), ${counts.failed} failed${counts.network ? `, ${counts.network} offline` : ""}`);
  return 0;
}
