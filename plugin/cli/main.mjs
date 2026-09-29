// The `shipment-tracker` CLI. The bin script wires real dependencies; tests
// call main() with a temp state dir, a fixed clock and fake transports.
//
// deps: { env, now: () => Date, transport: { fetch }, log(line), out(line), exec? }
// Logs carry counts and Health only, never tracking numbers, names or addresses.
import { refresh } from "./refresh.mjs";
import { manualDhlShipment, parseManualId } from "./shipments.mjs";
import { stateDirFor, updateState } from "./state.mjs";
import { install, uninstall } from "./systemd.mjs";

const USAGE = `usage: shipment-tracker <command>
  add <trackingNumber>   track a DHL tracking number by hand
  refresh                one refresh run
  install                install the hourly refresh timer (idempotent)
  uninstall              remove the refresh timer and service`;

export async function main(argv, deps) {
  const [command, ...args] = argv;
  const stateDir = stateDirFor(deps.env);
  switch (command) {
    case "add":
      return add(args, stateDir, deps);
    case "refresh":
      return refresh({ stateDir, now: deps.now, transport: deps.transport, log: deps.log });
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
