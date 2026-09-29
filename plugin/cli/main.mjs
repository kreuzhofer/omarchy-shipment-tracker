// The `shipment-tracker` CLI. The bin script wires real dependencies; tests
// call main() with a temp state dir, a fixed clock and fake transports.
//
// deps: { env, now: () => Date, transport: { fetch }, browser: { catchRedirect },
//         chrome: { launch }, sleep(ms), log(line), out(line), exec? }
// Local time (Amazon's quiet hours, Estimate days) uses env.TZ when set.
// Logs carry counts and Health only, never tracking numbers, names or addresses.
import { addAccount, loginAmazon, removeAccount } from "./amazon/connection.mjs";
import { addManualOrder } from "./amazon/manual.mjs";
import { dismiss, undismiss } from "./dismiss.mjs";
import { login as loginDhl } from "./login.mjs";
import { findByTrackingNumber } from "./merge.mjs";
import { refresh } from "./refresh.mjs";
import { manualDhlShipment, parseManualId, removeManual } from "./shipments.mjs";
import { stateDirFor, updateState } from "./state.mjs";
import { install, uninstall } from "./systemd.mjs";

const USAGE = `usage: shipment-tracker <command>
  add <id>               track a DHL tracking number or an Amazon Order ID by hand
  remove <shipmentKey>   stop tracking a Shipment added by hand
  dismiss <shipmentKey>  hide a Shipment until it gets a real update
  undismiss <shipmentKey>
                         show a Dismissed Shipment again
  login dhl              log in to dhl.de in a dedicated Chrome window, then sync
  login amazon:<label>   sign in to that account in its own Chrome window
  accounts add <label> --accept-risk
                         register an amazon.de account (then: login amazon:<label>)
  accounts remove <label>
                         remove it, its Chrome profile and its Shipments
  refresh [--source <key>]
                         one refresh run (all Connections, or one)
  install                install the hourly refresh timer (idempotent)
  uninstall              remove the refresh timer and service`;

export async function main(argv, deps) {
  const [command, ...args] = argv;
  const stateDir = stateDirFor(deps.env);
  const timeZone = deps.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const run = { ...deps, stateDir, timeZone };
  switch (command) {
    case "add":
      return add(args, stateDir, deps);
    case "remove":
      return remove(args, stateDir, deps);
    case "dismiss":
    case "undismiss":
      return setDismissed(command, args, stateDir, deps);
    case "login":
      return login(args, run);
    case "accounts":
      return accounts(args, run);
    case "refresh": {
      const source = refreshSource(args);
      if (source === undefined) {
        deps.log("usage: shipment-tracker refresh [--source <key>]");
        return 2;
      }
      return refresh({ ...run, source });
    }
    case "install":
      return install(deps);
    case "uninstall":
      return uninstall(deps);
    default:
      deps.log(USAGE);
      return 2;
  }
}

async function add(args, stateDir, { now, log, out }) {
  if (args.length !== 1) {
    log("usage: shipment-tracker add <trackingNumber|orderId>");
    return 2;
  }
  const parsed = parseManualId(args[0]);
  if (parsed.error) {
    log(`add: ${parsed.error}`);
    return 2;
  }
  const added = await updateState(stateDir, ({ shipments }) => {
    // Adding a dropped Shipment or Order by hand tracks it again (see retention.mjs).
    const key = `${parsed.kind}:${parsed.id}`;
    shipments.dropped = shipments.dropped.filter((d) => d.key !== key && !d.key.startsWith(`${key}#`));
    if (parsed.kind === "amazon") return addManualOrder(shipments.shipments, parsed.id, now());
    const shipment = manualDhlShipment(parsed.id, now());
    // A number an Amazon Shipment already carries joins that Shipment.
    const existing = findByTrackingNumber(shipments.shipments, parsed.id);
    if (existing) {
      if (!existing.connections.includes("manual")) existing.connections.push("manual");
      return false;
    }
    shipments.shipments.push(shipment);
    return true;
  });
  out(added ? "Added 1 Shipment" : "Already tracked");
  return 0;
}

async function remove(args, stateDir, { log, out }) {
  if (args.length !== 1) {
    log("usage: shipment-tracker remove <shipmentKey>");
    return 2;
  }
  const error = await updateState(stateDir, ({ shipments }) => removeManual(shipments, args[0]));
  if (error) {
    log(`remove: ${error}`);
    return 2;
  }
  out("Removed 1 Shipment");
  return 0;
}

async function setDismissed(command, args, stateDir, { now, log, out }) {
  if (args.length !== 1) {
    log(`usage: shipment-tracker ${command} <shipmentKey>`);
    return 2;
  }
  const error = await updateState(stateDir, ({ shipments }) => (command === "dismiss"
    ? dismiss(shipments, args[0], now())
    : undismiss(shipments, args[0])));
  if (error) {
    log(`${command}: ${error}`);
    return 2;
  }
  out(command === "dismiss" ? "Dismissed 1 Shipment" : "Undismissed 1 Shipment");
  return 0;
}

// [] → null (every Connection); ["--source", key] → key; anything else → undefined.
function refreshSource(args) {
  if (args.length === 0) return null;
  if (args.length === 2 && args[0] === "--source" && args[1]) return args[1];
  return undefined;
}

async function accounts([sub, label, ...flags], run) {
  if (sub === "add" && label) {
    const result = await addAccount(label, { acceptRisk: flags.includes("--accept-risk") }, run);
    if (result.error) {
      run.log(`accounts: ${result.error}`);
      return 2;
    }
    run.out(`Added Amazon · ${label}. Sign in with: shipment-tracker login amazon:${label}`);
    return 0;
  }
  if (sub === "remove" && label) {
    if (!(await removeAccount(label, run))) {
      run.log(`accounts: no Amazon account called ${label}`);
      return 2;
    }
    run.out(`Removed Amazon · ${label}`);
    return 0;
  }
  run.log("usage: shipment-tracker accounts add <label> --accept-risk | accounts remove <label>");
  return 2;
}

const AMAZON_LOGIN_RESULTS = {
  ok: [0, "Signed in; first sync done"],
  cancelled: [1, "Login cancelled"],
  "timed-out": [1, "Login timed out after 15 min"],
  browser: [1, "Chrome didn't start (or is already open for this account)"],
  busy: [1, "A refresh is reading this account; try again in a minute"],
  "unknown-account": [2, "No such Amazon account; add it with accounts add <label> --accept-risk"],
};

// `login dhl` or `login amazon:<label>`.
async function login(args, run) {
  const label = args.length === 1 ? args[0].match(/^amazon:(.+)$/)?.[1] : null;
  if (!label) {
    if (args.length === 1 && args[0] === "dhl") return loginDhl(args, run.stateDir, run);
    run.log("usage: shipment-tracker login dhl | login amazon:<label>");
    return 2;
  }
  const result = await loginAmazon(label, run);
  const [code, text] = AMAZON_LOGIN_RESULTS[result] ?? [1, `Signed in, but the first sync stopped: ${result}`];
  (code === 0 ? run.out : run.log)(`login: ${text}`);
  return code;
}
