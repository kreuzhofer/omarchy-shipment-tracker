// `login dhl`: DHL's app login in a dedicated Chrome profile. The browser
// transport opens the authorize URL and catches the `dhllogin://` redirect
// over CDP; we exchange the code, save the tokens and run the Connection's
// first sync. The user only logs in (2FA included).
//
// Where the login profile lives: the tracker's own data dir
// (~/.local/share/omarchy-shipment-tracker/dhl), never the user's normal
// browser profile. The Login lifecycle in sources.json (phase, deadline,
// returnTo, one at a time) is logins.mjs's; this is one attempt inside it.
import { join } from "node:path";
import { authorizeRequest, exchangeCode, readRedirect, REDIRECT_PREFIX } from "./dhl/auth.mjs";
import { runLogin } from "./logins.mjs";
import { refresh } from "./refresh.mjs";

const APP = "omarchy-shipment-tracker";

export function dataDirFor(env) {
  return join(env.XDG_DATA_HOME || join(env.HOME, ".local/share"), APP);
}

const OUTCOME_MESSAGES = {
  cancelled: "login cancelled (the window was closed)",
  "timed-out": "login timed out after 15 min",
  browser: "Chrome didn't come up",
};

export async function login(args, stateDir, deps) {
  const [key] = args;
  if (args.length !== 1 || key !== "dhl") {
    deps.log("usage: shipment-tracker login dhl");
    return 2;
  }
  return runLogin(key, { stateDir, ...deps }, (handle) => attempt(stateDir, deps, handle));
}

async function attempt(stateDir, deps, handle) {
  const request = authorizeRequest();
  deps.log("login: a Chrome window opens on the DHL login; log in there (2FA if asked). It closes by itself.");
  const deadline = await handle.window();
  let redirectUrl;
  try {
    redirectUrl = await deps.browser.catchRedirect({
      url: request.url,
      profileDir: join(dataDirFor(deps.env), "dhl"),
      redirectPrefix: REDIRECT_PREFIX,
      timeoutMs: Math.max(0, deadline.getTime() - deps.now().getTime()),
      signal: handle.signal,
    });
  } catch (e) {
    if (e.code === "cancelled" || e.code === "timed-out") handle.outcome = e.code;
    deps.log(`login: ${OUTCOME_MESSAGES[e.code] ?? "the login window failed"}`);
    return 1;
  }
  const redirect = readRedirect(redirectUrl, request.state);
  if (redirect.error) {
    deps.log(`login: ${redirect.error}`);
    return 1;
  }
  const exchanged = await exchangeCode({ stateDir, transport: deps.transport, now: deps.now }, { code: redirect.code, verifier: request.verifier });
  if (!exchanged.ok) {
    deps.log(`login: ${exchanged.message ?? `the code exchange failed (${exchanged.reason})`}`);
    return 1;
  }
  handle.outcome = "ok";
  await handle.syncing();
  deps.log("login: dhl logged in, running its first sync");
  return refresh({ stateDir, now: deps.now, transport: deps.transport, exec: deps.exec, log: deps.log, source: "dhl", firstSync: true });
}
