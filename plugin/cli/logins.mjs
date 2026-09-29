// The Login lifecycle (spec #21, "Login window lifecycle"; decided on #19).
// A Login in progress is the Connection's `login` field in sources.json, not a
// Health:
//   login: { phase: "waiting" | "window" | "syncing", startedAt, expiresAt, returnTo, unit, pid }
//   lastLogin: { result: "cancelled" | "timed-out" | "failed", at }
// "waiting": an Amazon profile is held by a refresh (up to 90 s). "window":
// the login window is open until `expiresAt` (15 minutes, every kind).
// "syncing": signed in, the first sync runs.
//
// Only one Login runs at a time. A Login that doesn't succeed puts Health
// back to `returnTo` and never touches tokens or profiles; `lastLogin` tells
// the user why until the next Login. A Login whose process is gone (its
// systemd unit inactive, or its pid dead when started outside a unit), or
// that is 5 min past its deadline, is stale: the next refresh (and the
// plugin, on load) clears it as `failed`.
//
// The plugin starts `login <key>` as the transient unit
// shipment-tracker-login-<escaped key> with SHIPMENT_TRACKER_UNIT set to that
// name; Cancel stops the unit, whose SIGTERM reaches `onCancel`.
import { connectionName, connectionRecord } from "./health.mjs";
import { updateState } from "./state.mjs";

export const LOGIN_DEADLINE_MS = 15 * 60_000;
const STALE_AFTER_MS = 5 * 60_000;

const active = (sources) => Object.entries(sources.connections ?? {}).filter(([, c]) => c?.login);

// Whether the process behind a Login still runs.
async function isRunning(login, { exec }) {
  if (login.unit) {
    if (!exec) return true;
    const result = await exec("systemctl", ["--user", "is-active", "--quiet", login.unit]);
    return result.code === 0;
  }
  if (Number.isInteger(login.pid)) {
    try {
      process.kill(login.pid, 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  }
  return true;
}

function end(connection, result, at) {
  const { returnTo } = connection.login;
  connection.login = null;
  connection.lastLogin = result === "ok" ? null : { result, at };
  if (result !== "ok" && returnTo && connection.health !== returnTo) {
    connection.health = returnTo;
    connection.since = at;
  }
}

// Clears every stale Login as failed (under the state lock). Returns the count.
export async function clearStaleLogins(sources, now, deps) {
  let count = 0;
  for (const [, c] of active(sources)) {
    const pastDeadline = now.getTime() - Date.parse(c.login.expiresAt) > STALE_AFTER_MS;
    if (!pastDeadline && await isRunning(c.login, deps)) continue;
    end(c, "failed", now.toISOString());
    count++;
  }
  return count;
}

// `clear-stale-logins`, run by the plugin on load.
export async function clearStale({ stateDir, now, exec, log }) {
  const count = await updateState(stateDir, ({ sources }) => clearStaleLogins(sources, now(), { exec }));
  if (count > 0) log(`clear-stale-logins: ${count} stale Login(s) cleared`);
  return 0;
}

// Runs one Login of `key` around `attempt(handle)`, which returns the exit
// code and sets `handle.outcome` ("ok" once signed in, "cancelled",
// "timed-out"; anything else counts as "failed"). The handle:
//   signal     aborts when the user cancels (SIGTERM from Cancel, Ctrl-C)
//   waiting()  the profile is held by a refresh
//   window()   the window opens now; returns its deadline (a Date)
//   syncing()  signed in; cancelling is no longer possible
// Refuses with exit code 1 while another Login runs.
export async function runLogin(key, { stateDir, env, now, exec, log, onCancel }, attempt) {
  const startedAt = now().toISOString();
  const other = await updateState(stateDir, async ({ sources }) => {
    await clearStaleLogins(sources, now(), { exec });
    const running = active(sources)[0];
    if (running) return running;
    const connection = connectionRecord(sources, key);
    connection.login = {
      phase: "window",
      startedAt,
      expiresAt: new Date(Date.parse(startedAt) + LOGIN_DEADLINE_MS).toISOString(),
      returnTo: connection.health,
      unit: env.SHIPMENT_TRACKER_UNIT || null,
      pid: process.pid,
    };
    connection.lastLogin = null;
    return null;
  });
  if (other) {
    log(`login: Finish the ${connectionName(other[0], other[1])} login first`);
    return 1;
  }

  // Changes this Login's record, unless it was cleared (as stale) meanwhile.
  const ours = (fn) => updateState(stateDir, ({ sources }) => {
    const c = sources.connections?.[key];
    if (c?.login?.startedAt === startedAt) return fn(c);
  });
  const cancel = new AbortController();
  let stopListening = onCancel?.(() => cancel.abort()) ?? (() => {});
  const handle = {
    signal: cancel.signal,
    outcome: "failed",
    waiting: () => ours((c) => { c.login.phase = "waiting"; }),
    async window() {
      const deadline = new Date(now().getTime() + LOGIN_DEADLINE_MS);
      await ours((c) => Object.assign(c.login, { phase: "window", expiresAt: deadline.toISOString() }));
      return deadline;
    },
    syncing() {
      stopListening();
      stopListening = () => {};
      return ours((c) => { c.login.phase = "syncing"; });
    },
  };
  try {
    return await attempt(handle);
  } finally {
    stopListening();
    const result = ["ok", "cancelled", "timed-out"].includes(handle.outcome) ? handle.outcome : "failed";
    await ours((c) => end(c, result, now().toISOString()));
  }
}
