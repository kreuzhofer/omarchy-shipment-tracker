// How the tracker drives an Amazon account's Chrome (spec #21, "Source
// adapters"; research on branch research/low-detection-automation).
//
// The installed Chrome, headful, with the account's own profile and a fixed
// loopback debugging port. Never headless, never automation flags, never
// `--remote-debugging-pipe` or port 0 (each sets navigator.webdriver). The CDP
// session only navigates and reads DOM.getOuterHTML: no Runtime domain, no
// injected script, no emulation or UA overrides. A Login may also open a
// local page in a background tab (the password-manager hint, #51), which the
// session never attaches to.
//
// `chrome` (deps.chrome) is the transport: launch({ args, port, hidden }) →
// { send(method, params, sessionId), onEvent(fn) → off, closed, hide(), close() }.
// The real one is chrome.mjs; tests pass a fake.
import { join } from "node:path";

export const CHROME_CLASS = "ShipmentTrackerChrome";
const LOAD_TIMEOUT_MS = 30_000;

export function dataDirFor(env) {
  return join(env.XDG_DATA_HOME || join(env.HOME, ".local/share"), "omarchy-shipment-tracker");
}

export const profileDirFor = (env, label) => join(dataDirFor(env), "amazon", label);

export function chromeArgs(profileDir, port) {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--password-store=gnome-libsecret",
    `--class=${CHROME_CLASS}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
}

// Opens the account's Chrome and attaches to its one tab. Throws an error with
// code "browser" when Chrome or its DevTools endpoint doesn't come up, or
// "busy" when something already listens on the account's port.
export async function openAccountBrowser(chrome, { profileDir, port, hidden }) {
  const browser = await chrome.launch({ args: chromeArgs(profileDir, port), port, hidden });
  try {
    const { targetInfos } = await browser.send("Target.getTargets");
    let target = targetInfos.find((t) => t.type === "page");
    if (!target) target = { targetId: (await browser.send("Target.createTarget", { url: "about:blank" })).targetId };
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    await browser.send("Page.enable", {}, sessionId);
    return new AccountTab(browser, target.targetId, sessionId);
  } catch (e) {
    await browser.close().catch(() => {});
    throw Object.assign(new Error(`browser: ${e.message}`), { code: "browser" });
  }
}

class AccountTab {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.closed = browser.closed;
  }

  // Navigates and waits for the load event (or 30 s). Returns false when
  // Chrome reports a network error for the navigation.
  async navigate(url) {
    let off;
    let timer;
    const loaded = new Promise((resolve) => {
      off = this.browser.onEvent((msg) => {
        if (msg.method === "Page.loadEventFired" && msg.sessionId === this.sessionId) resolve();
      });
      timer = setTimeout(resolve, LOAD_TIMEOUT_MS);
    });
    try {
      const result = await this.browser.send("Page.navigate", { url }, this.sessionId);
      if (result?.errorText) return false;
      await loaded;
      return true;
    } finally {
      off();
      clearTimeout(timer);
    }
  }

  // Opens `url` in a second tab without switching to it; this tab stays active.
  async openBackgroundTab(url) {
    await this.browser.send("Target.createTarget", { url, background: true });
  }

  async url() {
    return (await this.browser.send("Target.getTargetInfo", { targetId: this.targetId })).targetInfo.url;
  }

  async html() {
    const { root } = await this.browser.send("DOM.getDocument", { depth: -1 }, this.sessionId);
    return (await this.browser.send("DOM.getOuterHTML", { nodeId: root.nodeId }, this.sessionId)).outerHTML;
  }

  hide() {
    return this.browser.hide();
  }

  close() {
    return this.browser.close();
  }
}
