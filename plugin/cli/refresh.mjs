// One refresh run: the only writer of Status, Health and events[].
//
// Run order (spec #21): the DHL Connection (when logged in), then anonymous
// lookups of the DHL numbers the Sendungsliste didn't list (manual adds and
// numbers learned from Amazon), then the Microsoft 365 mailbox, then each
// Amazon account (so an Order first seen in mail gets its tracker page in the
// same run), then lookups of DHL numbers Amazon showed for the first time.
// Each number is looked up at most once per run. `source` limits the run to
// one Connection key ("dhl", "mail" or "amazon:<label>", for Retry); lookups
// then wait for the next full run. A Connection that fails never stops the
// others.
//
// Network requests happen outside the state lock; their results are applied
// under it, re-reading the files first so a concurrent `add` is never lost.
// A Shipment added while a run is in flight is picked up by the next round of
// the same run.
//
// Notification events: every Shipment that has been read gets its mark at the
// start (markKnown), and the run's events are recorded once at the end, after
// every Connection, so the >3 collapse sees the whole run (see events.mjs).
// Connection events (entering needs-login) follow them, from the same id
// sequence (see health.mjs).
// Dismissed Shipments that got a real update come back at the same point
// (see dismiss.mjs).
import { refreshAmazon } from "./amazon/connection.mjs";
import { hasTokens } from "./dhl/auth.mjs";
import { applyDhlSync, KEY as DHL, syncDhl } from "./dhl/connection.mjs";
import { lookupAnonymous } from "./dhl/search.mjs";
import { readDhlElement } from "./dhl/status.mjs";
import { KEY as MAIL, refreshMail } from "./mail/connection.mjs";
import { clearUpdatedDismissals } from "./dismiss.mjs";
import { firstSyncConnections, markKnown, recordEvents } from "./events.mjs";
import { recordConnectionEvents, recordFailure } from "./health.mjs";
import { clearStaleLogins } from "./logins.mjs";
import { applyDhlReading, carriedByDhl } from "./merge.mjs";
import { applyRetention } from "./retention.mjs";
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
export async function refresh({ stateDir, env, now, transport, chrome, mcp, sleep, timeZone, log, exec, source = null, firstSync = false }) {
  const attempted = new Set();
  const counts = { lookedUp: 0, unknown: 0, failed: 0, network: 0, synced: 0 };
  // Called by every part of the run that got to write its results.
  const finishRun = (sources, at) => {
    sources.lastRun = at.toISOString();
    // Offline is not an error: only the subtitle changes. `lastOnline` is
    // the last run that got through ("Offline · updated 3 h ago").
    sources.offline = counts.network > 0 && counts.network === counts.failed && counts.lookedUp === 0 && counts.synced === 0;
    if (!sources.offline) sources.lastOnline = sources.lastRun;
  };
  // DHL runs first, so whether its network failure is its own (something
  // else in the run got through) is only known at the end of the run.
  let dhlNetworkFailure = false;
  let mailNetworkFailure = false;
  // The header reads "Refreshing…" while this is set. A Login whose process
  // is gone ends as failed, so nothing sticks at "Connecting…".
  const quiet = await updateState(stateDir, async ({ shipments, sources }) => {
    sources.refreshing = { startedAt: now().toISOString() };
    if (await clearStaleLogins(sources, now(), { exec })) log("refresh: stale Login cleared");
    markKnown(shipments);
    return firstSyncConnections(sources);
  });
  if (firstSync && source) quiet.add(source);

  if ((source === null || source === DHL) && await hasTokens(stateDir)) {
    // The empty-list check compares with the last successful sync; a Login's
    // first sync skips it.
    const previousCount = firstSync && source === DHL ? 0 : (await readState(stateDir)).sources.connections?.[DHL]?.lastCount ?? 0;
    const outcome = await syncDhl({ stateDir, transport, now, previousCount });
    if (outcome.ok) counts.synced++;
    else {
      counts.failed++;
      if (outcome.reason === "network") {
        counts.network++;
        dhlNetworkFailure = true;
      }
    }
    const listed = await updateState(stateDir, async (state) => {
      // Disconnected while the sync was in flight: nothing of it counts.
      if (!(await hasTokens(stateDir))) return new Set();
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

  if (source === null || source === MAIL) {
    const mail = await refreshMail({ stateDir, mcp, now, timeZone, log, counts, finishRun });
    mailNetworkFailure = mail?.reason === "network" && !mail.counted;
  }

  if (source === null || source.startsWith("amazon:")) {
    await refreshAmazon({ stateDir, env, now, chrome, sleep, timeZone, log, counts, finishRun, only: source });
    await lookUp({ afterAmazon: true });
  }

  // "Refreshing…" lasts the whole run, Amazon's paced page reads included.
  // Retention runs before the events, so a Shipment dropped now tells nothing;
  // Connection events follow the Shipment events.
  const { told, dropped } = await updateState(stateDir, (state) => {
    state.sources.refreshing = null;
    if (dhlNetworkFailure && (counts.synced > 0 || counts.lookedUp > 0) && state.sources.connections?.[DHL]) {
      recordFailure(state.sources.connections[DHL], now(), "network", { countNetwork: true });
    }
    if (mailNetworkFailure && (counts.synced > 0 || counts.lookedUp > 0) && state.sources.connections?.[MAIL]) {
      recordFailure(state.sources.connections[MAIL], now(), "network", { countNetwork: true });
    }
    const dropped = applyRetention(state, now());
    // Notifications ignore dismissals; an update notifies and brings the row
    // back. A Shipment retention dropped is gone, dismissal and all.
    clearUpdatedDismissals(state.shipments);
    const told = recordEvents(state.shipments, { firstSync: quiet }) + recordConnectionEvents(state.shipments, state.sources);
    return { told, dropped };
  });
  if (dropped > 0) log(`refresh: ${dropped} Shipment(s) past retention dropped`);
  if (told > 0) log(`refresh: ${told} notification event(s)`);

  log(`refresh: looked up ${counts.lookedUp} (${counts.unknown} unknown), ${counts.failed} failed${counts.network ? `, ${counts.network} offline` : ""}`);
  return 0;
}
