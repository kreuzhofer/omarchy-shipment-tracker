// The systemd user units that drive refreshes (spec #21, "Architecture"): an
// hourly timer with a randomized delay that catches up after suspend, and a
// oneshot service so runs never overlap. "Refresh now" starts the service.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICE = "shipment-tracker-refresh.service";
export const TIMER = "shipment-tracker-refresh.timer";

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

// Idempotent: rewrites a unit only when it changed, then makes sure the timer
// is enabled and running.
export async function install({ env, exec, log }) {
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
  const enabled = await systemctl(exec, ["enable", "--now", TIMER]);
  if (enabled.code !== 0) {
    log(`install: could not enable ${TIMER}: ${enabled.stderr.trim()}`);
    return 1;
  }
  log(changed ? `install: ${TIMER} installed` : `install: ${TIMER} already installed`);
  return 0;
}

export async function uninstall({ env, exec, log }) {
  await systemctl(exec, ["disable", "--now", TIMER]);
  await systemctl(exec, ["stop", SERVICE]);
  const dir = unitDir(env);
  for (const name of [SERVICE, TIMER]) await rm(join(dir, name), { force: true });
  await systemctl(exec, ["daemon-reload"]);
  log(`uninstall: ${TIMER} removed`);
  return 0;
}

const systemctl = (exec, args) => exec("systemctl", ["--user", ...args]);
