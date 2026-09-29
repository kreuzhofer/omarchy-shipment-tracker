// The state dir and its two files, shipments.json and sources.json (schemas in
// spec #21, "Files and schemas"). Every write is a read-modify-write under the
// state-dir flock, and every file lands atomically (temp file + rename), so the
// plugin's FileView never sees a half-written file.
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { withLock } from "./lock.mjs";

const APP = "omarchy-shipment-tracker";
export const LOCK_FILE = "sources.json.lock";

export function stateDirFor(env) {
  const base = env.XDG_STATE_HOME || join(env.HOME, ".local/state");
  return join(base, APP);
}

const emptyShipments = () => ({ shipments: [], dropped: [], lastEventId: 0, events: [] });
const emptySources = () => ({ lastRun: null, refreshing: null, offline: false, connections: {} });

async function readJson(path, fallback) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return fallback();
    throw e;
  }
  return { ...fallback(), ...JSON.parse(text) };
}

// Unlocked snapshot. Safe because writes are atomic; use it to decide what to
// fetch, then apply the results with updateState.
export async function readState(stateDir) {
  return {
    shipments: await readJson(join(stateDir, "shipments.json"), emptyShipments),
    sources: await readJson(join(stateDir, "sources.json"), emptySources),
  };
}

export async function ensureStateDir(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
}

// Locks the state dir, reads both files, lets `mutate` change them in place,
// and writes both back atomically.
export async function updateState(stateDir, mutate) {
  await ensureStateDir(stateDir);
  return withLock(join(stateDir, LOCK_FILE), async () => {
    const state = await readState(stateDir);
    const result = await mutate(state);
    await writeAtomic(join(stateDir, "shipments.json"), state.shipments);
    await writeAtomic(join(stateDir, "sources.json"), state.sources);
    return result;
  });
}

export async function writeAtomic(path, data, mode = 0o600) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const handle = await open(tmp, "w", mode);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
