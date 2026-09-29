// The `shipment-tracker` CLI. The bin script wires real dependencies; tests
// call main() with a temp state dir, a fixed clock and fake transports.
//
// deps: { env, now: () => Date, transport: { fetch }, browser: { catchRedirect }, log(line), out(line), exec? }
// Logs carry counts and Health only, never tracking numbers, names or addresses.
import { login } from "./login.mjs";
import { refresh } from "./refresh.mjs";
import { manualDhlShipment, parseManualId, removeManual } from "./shipments.mjs";
import { stateDirFor, updateState } from "./state.mjs";
import { install, uninstall } from "./systemd.mjs";

const USAGE = `usage: shipment-tracker <command>
  add <trackingNumber>   track a DHL tracking number by hand
  remove <shipmentKey>   stop tracking a Shipment added by hand
  login dhl              log in to dhl.de in a dedicated Chrome window, then sync
  refresh [--source <key>]
                         one refresh run (all Connections, or one)
  install                install the hourly refresh timer (idempotent)
  uninstall              remove the refresh timer and service`;

export async function main(argv, deps) {
  const [command, ...args] = argv;
  const stateDir = stateDirFor(deps.env);
  switch (command) {
    case "add":
      return add(args, stateDir, deps);
    case "remove":
      return remove(args, stateDir, deps);
    case "login":
      return login(args, stateDir, deps);
    case "refresh": {
      const source = refreshSource(args);
      if (source === undefined) {
        deps.log("usage: shipment-tracker refresh [--source <key>]");
        return 2;
      }
      return refresh({ stateDir, now: deps.now, transport: deps.transport, log: deps.log, source });
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
    log("usage: shipment-tracker add <trackingNumber>");
    return 2;
  }
  const parsed = parseManualId(args[0]);
  if (parsed.error) {
    log(`add: ${parsed.error}`);
    return 2;
  }
  const added = await updateState(stateDir, ({ shipments }) => {
    const shipment = manualDhlShipment(parsed.id, now());
    const existing = shipments.shipments.find((s) => s.key === shipment.key);
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

// [] → null (every Connection); ["--source", key] → key; anything else → undefined.
function refreshSource(args) {
  if (args.length === 0) return null;
  if (args.length === 2 && args[0] === "--source" && args[1]) return args[1];
  return undefined;
}
