// The real browser transport for logins: the installed google-chrome-stable
// with a dedicated profile and a fixed loopback debugging port, driven over a
// minimal raw CDP client (Node's built-in WebSocket). Tests replace it with a
// fake. Verified by hand, not by the test suite (spec #21, "Testing Decisions").
//
// catchRedirect opens `url` in a visible window, auto-attaches to every page
// target and watches every CDP event for a URL starting with `redirectPrefix`
// (live, DHL's `dhllogin://` arrived in Network.responseReceivedExtraInfo, the
// raw 302 headers). It resolves with that URL and closes the window. It
// rejects with code "cancelled" when the user closes the window or `signal`
// aborts (Cancel), "timed-out" after `timeoutMs`, or "browser" when Chrome or
// CDP doesn't come up.
//
// With `hintUrl` (the password-manager hint, see login-hint.mjs) it also opens
// that page in a second tab, in the background (Target.createTarget with
// background: true) once the login page's tab exists, so the login page stays
// the active tab. No script is injected anywhere.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { DHL_LOGIN_PORT } from "./ports.mjs";

const CHROME = "google-chrome-stable";
const STARTUP_MS = 15_000;

const fail = (code, message) => Object.assign(new Error(message), { code });
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const chromeBrowser = {
  async catchRedirect({ url, profileDir, redirectPrefix, timeoutMs, signal, hintUrl = null, port = DHL_LOGIN_PORT }) {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    let chrome;
    try {
      chrome = spawn(CHROME, [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=gnome-libsecret",
        "--new-window",
        url,
      ], { stdio: "ignore", detached: true });
      chrome.on("error", () => {});
      chrome.exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.unref();
    } catch {
      throw fail("browser", "Chrome could not be started");
    }
    const wsUrl = await devtoolsUrl(port);
    const ws = new WebSocket(wsUrl);
    try {
      return await watch(ws, new RegExp(`${escapeRegExp(redirectPrefix)}[^"'\\s\\\\]*`), timeoutMs, signal, hintUrl);
    } finally {
      await closeBrowser(ws, chrome);
    }
  },
};

async function devtoolsUrl(port) {
  const deadline = Date.now() + STARTUP_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      const { webSocketDebuggerUrl } = await response.json();
      if (webSocketDebuggerUrl) return webSocketDebuggerUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw fail("browser", "Chrome's DevTools endpoint did not come up");
}

function watch(ws, pattern, timeoutMs, signal, hintUrl) {
  return new Promise((resolve, reject) => {
    let id = 0;
    let settled = false;
    const pages = new Set();
    let sawPage = false;
    let hintOpened = !hintUrl;
    // Once the login page's tab exists, so the hint lands in the same window.
    const openHint = () => {
      if (hintOpened) return;
      hintOpened = true;
      send("Target.createTarget", { url: hintUrl, background: true });
    };
    const send = (method, params = {}, sessionId) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: ++id, method, params, ...(sessionId ? { sessionId } : {}) }));
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => settle(reject, fail("timed-out", "login timed out")), timeoutMs);
    const onAbort = () => settle(reject, fail("cancelled", "the login was cancelled"));
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    ws.onopen = () => {
      send("Target.setDiscoverTargets", { discover: true });
      send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      send("Target.getTargets");
    };
    ws.onerror = () => settle(reject, fail("browser", "CDP connection failed"));
    // The browser went away: the user closed the last window.
    ws.onclose = () => settle(reject, fail("cancelled", "the login window was closed"));
    ws.onmessage = (message) => {
      const text = String(message.data);
      const hit = text.match(pattern);
      if (hit) {
        settle(resolve, hit[0].replace(/\\u0026/g, "&"));
        return;
      }
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      if (m.method === "Target.attachedToTarget") {
        const sessionId = m.params.sessionId;
        send("Network.enable", {}, sessionId);
        send("Page.enable", {}, sessionId);
        send("Runtime.runIfWaitingForDebugger", {}, sessionId);
      } else if (m.method === "Target.targetCreated" && m.params.targetInfo.type === "page") {
        pages.add(m.params.targetInfo.targetId);
        sawPage = true;
        openHint();
      } else if (m.method === "Target.targetDestroyed" && pages.delete(m.params.targetId) && sawPage && pages.size === 0) {
        settle(reject, fail("cancelled", "the login window was closed"));
      } else if (m.result?.targetInfos) {
        for (const t of m.result.targetInfos) {
          if (t.type !== "page") continue;
          pages.add(t.targetId);
          sawPage = true;
          if (!t.attached) send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        }
        if (sawPage) openHint();
      }
    };
  });
}

// Closes the window and waits for Chrome to exit (at most a few seconds), so
// the next login can take the profile and the port again.
async function closeBrowser(ws, chrome) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 1e9, method: "Browser.close" }));
  } catch {}
  const gone = await Promise.race([chrome.exited.then(() => true), new Promise((resolve) => setTimeout(resolve, 3000, false))]);
  try { ws.close(); } catch {}
  if (!gone) {
    try { process.kill(-chrome.pid); } catch {}
  }
}
