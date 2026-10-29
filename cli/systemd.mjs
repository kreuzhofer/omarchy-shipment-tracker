// The systemd user units that drive refreshes (spec #21, "Architecture"): an
// hourly timer with a randomized delay that catches up after suspend, and a
// oneshot service so runs never overlap. "Refresh now" starts the service.
// Retry on a banner starts the template instance for one Connection
// (shipment-tracker-refresh@<systemd-escaped key>.service → refresh --source <key>).
// Close to a delivery (#80), a second timer every 15 min starts
// shipment-tracker-refresh-close.service (refresh --source dhl --if-close),
// which returns at once, offline, unless a DHL Shipment is out for delivery or
// due today.
//
// Background refresh is opt-in (#90): nothing is written to
// ~/.config/systemd/user until the user turns it on. The choice is
// `backgroundRefresh` in sources.json: "on", "off", or null (never asked).
// `install` and `uninstall` record it; `ensure-timers`, run by the plugin on
// load, repairs the units only when it is "on". Units from before #90 count
// as "on".
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readState, updateState } from "./state.mjs";

export const SERVICE = "shipment-tracker-refresh.service";
export const TIMER = "shipment-tracker-refresh.timer";
export const SOURCE_SERVICE = "shipment-tracker-refresh@.service";
export const CLOSE_SERVICE = "shipment-tracker-refresh-close.service";
export const CLOSE_TIMER = "shipment-tracker-refresh-close.timer";
const TIMERS = [TIMER, CLOSE_TIMER];

const unitDir = (env) => join(env.XDG_CONFIG_HOME || join(env.HOME, ".config"), "systemd/user");
const quote = (arg) => `"${arg.replace(/["\\]/g, "\\$&")}"`;

function units(nodePath, cliPath) {
  return {
    [SERVICE]: `[Unit]
Description=Shipment tracker refresh

[Service]
Type=oneshot
ExecStart=${quote(nodePath)} ${quote(cliPath)} refresh
`,
    [SOURCE_SERVICE]: `[Unit]
Description=Shipment tracker refresh of one Connection (%I)

[Service]
Type=oneshot
ExecStart=${quote(nodePath)} ${quote(cliPath)} refresh --source "%I"
`,
    [CLOSE_SERVICE]: `[Unit]
Description=Shipment tracker DHL refresh while a delivery is close

[Service]
Type=oneshot
ExecStart=${quote(nodePath)} ${quote(cliPath)} refresh --source dhl --if-close
`,
    [CLOSE_TIMER]: `[Unit]
Description=Shipment tracker DHL refresh every 15 min (does nothing unless a delivery is close)

[Timer]
OnCalendar=*:0/15
RandomizedDelaySec=60
Persistent=false

[Install]
WantedBy=timers.target
`,
    [TIMER]: `[Unit]
Description=Hourly Shipment tracker refresh

[Timer]
OnCalendar=hourly
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

const setChoice = (stateDir, value) => updateState(stateDir, ({ sources }) => { sources.backgroundRefresh = value; });

// Turns background refresh on. Idempotent: rewrites a unit only when it
// changed, then makes sure both timers are enabled and running.
export async function install({ env, exec, log, stateDir }) {
  await setChoice(stateDir, "on");
  return writeUnits({ env, exec, log });
}

async function writeUnits({ env, exec, log }) {
  const dir = unitDir(env);
  await mkdir(dir, { recursive: true });
  const cliPath = fileURLToPath(new URL("./shipment-tracker.mjs", import.meta.url));
  let changed = false;
  for (const [name, content] of Object.entries(units(process.execPath, cliPath))) {
    const path = join(dir, name);
    const current = await readFile(path, "utf8").catch(() => null);
    if (current === content) continue;
    await writeFile(path, content);
    changed = true;
  }
  if (changed) await systemctl(exec, ["daemon-reload"]);
  for (const timer of TIMERS) {
    const enabled = await systemctl(exec, ["enable", "--now", timer]);
    if (enabled.code !== 0) {
      log(`install: could not enable ${timer}: ${enabled.stderr.trim()}`);
      return 1;
    }
  }
  log(changed ? `install: ${TIMERS.join(", ")} installed` : `install: ${TIMERS.join(", ")} already installed`);
  return 0;
}

// Turns background refresh off (also "Not now"): it stays off across shell
// starts. With nothing installed it only records the choice.
export async function uninstall({ env, exec, log, stateDir }) {
  await setChoice(stateDir, "off");
  if (!(await anyUnit(env))) {
    log("uninstall: background refresh off (nothing installed)");
    return 0;
  }
  for (const timer of TIMERS) await systemctl(exec, ["disable", "--now", timer]);
  await systemctl(exec, ["stop", SERVICE, CLOSE_SERVICE]);
  const dir = unitDir(env);
  for (const name of [SERVICE, SOURCE_SERVICE, TIMER, CLOSE_SERVICE, CLOSE_TIMER]) await rm(join(dir, name), { force: true });
  await systemctl(exec, ["daemon-reload"]);
  log(`uninstall: ${TIMERS.join(", ")} removed`);
  return 0;
}

// On shell start: re-install (repair) the units only if background refresh
// is on; a timer left by a version before #90 means it is.
export async function ensureTimers({ env, exec, log, stateDir }) {
  const { sources } = await readState(stateDir);
  let value = sources.backgroundRefresh ?? null;
  if (value === null && await exists(join(unitDir(env), TIMER))) {
    await setChoice(stateDir, "on");
    value = "on";
  }
  if (value !== "on") return 0;
  return writeUnits({ env, exec, log });
}

const exists = (path) => stat(path).then(() => true, () => false);
async function anyUnit(env) {
  for (const name of [SERVICE, SOURCE_SERVICE, TIMER, CLOSE_SERVICE, CLOSE_TIMER]) {
    if (await exists(join(unitDir(env), name))) return true;
  }
  return false;
}

const systemctl = (exec, args) => exec("systemctl", ["--user", ...args]);
