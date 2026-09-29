// Removing and disconnecting Connections (spec #21, "Removing and
// disconnecting"). First the Connection's sign-in goes: DHL's token file and
// its Chrome login profile here, an Amazon account's Chrome profile in
// amazon/connection.mjs (`accounts remove`). Then, under the state lock,
// forgetConnection: Health back to not-set-up, and the Shipments known only
// through it go at once. Merged Shipments keep their other side, manual adds
// stay (see amazon/manual.mjs, releaseOwnership). With no Connection left set
// up, the popup is back at its first run.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { releaseOwnership, settleLinkOnly } from "./amazon/manual.mjs";
import { forgetTokens } from "./dhl/auth.mjs";
import { connectionName, connectionRecord } from "./health.mjs";
import { clearStaleLogins } from "./logins.mjs";
import { signOutMail } from "./mail/connection.mjs";
import { dataDirFor, updateState } from "./state.mjs";

// What `disconnect <key>` deletes, per Connection. Mail: Softeria's logout,
// which clears its token cache (see mail/connection.mjs).
const SIGN_INS = {
  async dhl({ stateDir, env }) {
    await forgetTokens(stateDir);
    await rm(join(dataDirFor(env), "dhl"), { recursive: true, force: true });
  },
  mail: signOutMail,
};

export const disconnectable = () => Object.keys(SIGN_INS);

// Under the state lock. An Amazon account's key goes with it; DHL and mail
// keep a record that says not-set-up, since `at`.
export function forgetConnection({ sources, shipments }, key, at) {
  delete sources.connections[key];
  if (!key.startsWith("amazon:")) connectionRecord(sources, key).since = at.toISOString();
  shipments.shipments = releaseOwnership(shipments.shipments, key);
  // A manual Order ID no account (left) can own is link-only at once.
  settleLinkOnly(shipments.shipments, sources.connections);
}

// `disconnect <dhl|…>`. Refused while that Connection's Login runs: the
// Login would sign it in again. Disconnecting what isn't connected is fine.
export async function disconnect(args, { stateDir, env, now, exec, mcp, log, out }) {
  const [key] = args;
  if (args.length !== 1 || !Object.hasOwn(SIGN_INS, key)) {
    log(`usage: shipment-tracker disconnect <${disconnectable().join("|")}>`);
    return 2;
  }
  const loggingIn = await updateState(stateDir, async ({ sources }) => {
    await clearStaleLogins(sources, now(), { exec });
    return Boolean(sources.connections[key]?.login);
  });
  const name = connectionName(key);
  if (loggingIn) {
    log(`disconnect: Finish or cancel the ${name} login first`);
    return 1;
  }
  await SIGN_INS[key]({ stateDir, env, mcp, log });
  await updateState(stateDir, (state) => forgetConnection(state, key, now()));
  out(`Disconnected ${name}`);
  return 0;
}
