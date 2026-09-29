// The password-manager hint (#51). Login windows run in dedicated Chrome
// profiles (Chrome ≥136 refuses remote debugging on the default one), so the
// user's password manager isn't there until they install it once in that
// profile; it then stays for every Login and hidden refresh.
//
// While a login profile has no extension, a visible Login window opens a
// second tab in the background with login-hint.html, a local page pointing
// to the Chrome Web Store; the login page stays the active tab. The hidden
// refresh never opens it. Nothing is installed for the user, and there are
// no Chrome policies.
//
// A profile "has extensions" when its Default/Extensions folder holds an
// extension other than the ones Chrome puts into every new profile itself.
// Logins and refreshes record it as `hasExtensions` on the Connection in
// sources.json (missing means none), for the hint on the Sources page.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { profileDirFor } from "./amazon/browser.mjs";
import { dataDirFor, updateState } from "./state.mjs";

export const HINT_URL = new URL("./login-hint.html", import.meta.url).href;

// Chrome's own default and component extensions, which appear in a fresh
// profile without the user installing anything.
const BUILT_IN = new Set([
  "ghbmnnjooekpmoecnnnilnnbdlolhkhi", // Google Docs Offline
  "nmmhkkegccagdldgiimedpiccmgmieda", // Chrome Web Store Payments
  "pkedcjkdefgpdelpbcmbmeomcjbeemfm", // Chrome Media Router
  "mhjfbmdgcfjbbpaeojofohoefgiehjai", // Chrome PDF Viewer
  "ahfgeienlihckogmohjhadlkjgocpleb", // Chrome Web Store
  "aapocclcgogkmnckokdopfmhonfmgoek", // Slides
  "aohghmighlieiainnegkcijnfilokake", // Docs
  "apdfllckaahabafndbhieahigkjlhalf", // Google Drive
  "felcaaldnbdncclmgdcncolpebgiejap", // Sheets
  "blpcfgokakmgnkcojhhkbfbldkacnbeo", // YouTube
  "pjkljhegncpnkpknbcohdijeoejaedia", // Gmail
  "coobgpohoikkiipiblmjeljniedjpjpf", // Web Search
  "neajdppkdcdipfabeoofebfddakdcjhd", // Google Network Speech
  "gfdkimpbcpahaombhbimeihdjnejgicl", // Feedback
]);
// An extension ID: 32 letters a–p. Skips Chrome's "Temp" folder.
const EXTENSION_ID = /^[a-p]{32}$/;

export async function hasExtensions(profileDir) {
  let entries;
  try {
    entries = await readdir(join(profileDir, "Default", "Extensions"), { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isDirectory() && EXTENSION_ID.test(e.name) && !BUILT_IN.has(e.name));
}

// The login profile behind a Connection, or null (mail has none).
export function loginProfileDir(env, key, connection) {
  if (key === "dhl") return join(dataDirFor(env), "dhl");
  if (key.startsWith("amazon:") && connection?.label) return profileDirFor(env, connection.label);
  return null;
}

// Checks every Connection's login profile and records `hasExtensions` (under
// the state lock). `keys` limits it to those Connections. A missing flag
// means none, so a Connection gets it once its profile has an extension, and
// only a profile that lost them (the user uninstalled it) gets false.
export async function recordExtensions(stateDir, env, keys = null) {
  return updateState(stateDir, async ({ sources }) => {
    for (const [key, connection] of Object.entries(sources.connections ?? {})) {
      if (keys && !keys.includes(key)) continue;
      const profileDir = connection && loginProfileDir(env, key, connection);
      if (!profileDir) continue;
      const has = await hasExtensions(profileDir);
      if (has !== (connection.hasExtensions === true)) connection.hasExtensions = has;
    }
  });
}
