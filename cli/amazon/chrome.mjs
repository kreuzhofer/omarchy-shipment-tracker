// The real Chrome transport for Amazon accounts: spawns the installed
// google-chrome-stable, parks its window on Hyprland's hidden special
// workspace, and speaks raw CDP over the loopback WebSocket. See browser.mjs
// for the rules (headful, fixed port, no Runtime domain). Verified by hand;
// tests replace it with a fake.
import { execFile, spawn } from "node:child_process";
import { CHROME_CLASS } from "./browser.mjs";

const CHROME = "google-chrome-stable";
const HIDDEN_WORKSPACE = "special:shiptracker";
const STARTUP_MS = 20_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (code, message) => Object.assign(new Error(message), { code });

async function devtoolsVersion(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return await response.json();
  } catch {
    return null;
  }
}

const hyprctl = (args) => new Promise((resolve) => {
  execFile("hyprctl", args, { timeout: 5000 }, (error, stdout) => resolve(error ? null : stdout));
});

// Chrome's Wayland app_id follows --class (spike #8). One tracker Chrome runs
// at a time, so the class finds it when the pid doesn't (Chrome forks).
async function findWindow(pid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const out = await hyprctl(["clients", "-j"]);
    const clients = out ? JSON.parse(out) : [];
    const window = clients.find((c) => c.pid === pid) ?? clients.find((c) => c.class === CHROME_CLASS);
    if (window) return window;
    await sleep(200);
  }
  return null;
}

// Hyprland 0.56 Lua dispatch; follow = false keeps the user where they are.
async function moveToHiddenWorkspace(pid) {
  const window = await findWindow(pid);
  if (!window) return false;
  const lua = `hl.dsp.window.move({ workspace = "${HIDDEN_WORKSPACE}", follow = false, window = "address:${window.address}" })`;
  return (await hyprctl(["dispatch", lua])) !== null;
}

export const realChrome = {
  async launch({ args, port, hidden }) {
    if (await devtoolsVersion(port)) throw fail("busy", `port ${port} is already in use`);
    const child = spawn(CHROME, args, { stdio: "ignore", detached: true });
    child.unref();
    const exited = new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    });
    const hiding = hidden ? moveToHiddenWorkspace(child.pid) : null;

    let version = null;
    const deadline = Date.now() + STARTUP_MS;
    while (!version && Date.now() < deadline) {
      version = await devtoolsVersion(port);
      if (!version) await sleep(200);
    }
    if (!version?.webSocketDebuggerUrl) {
      try { process.kill(-child.pid); } catch {}
      throw fail("browser", "Chrome's DevTools endpoint did not come up");
    }
    await hiding;
    const browser = await connect(version.webSocketDebuggerUrl);
    return {
      ...browser,
      async hide() {
        await moveToHiddenWorkspace(child.pid);
      },
      async close() {
        try { await browser.send("Browser.close"); } catch {}
        browser.disconnect();
        const gone = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]);
        if (!gone) try { process.kill(-child.pid, "SIGTERM"); } catch {}
      },
    };
  },
};

// A minimal CDP client over Node's WebSocket. It has no Runtime.* helper on
// purpose; `send` passes any method through, so browser.mjs is the only
// place that decides what is called.
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(fail("browser", "could not connect to Chrome's DevTools"));
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  let markClosed;
  const closed = new Promise((resolve) => { markClosed = resolve; });
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(fail("browser", msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const listener of listeners) listener(msg);
      // The user closed the tab we are attached to (closing the window ends
      // Chrome and with it the socket).
      if (msg.method === "Target.detachedFromTarget") markClosed();
    }
  };
  ws.onclose = () => {
    markClosed();
    for (const { reject } of pending.values()) reject(fail("browser", "Chrome went away"));
    pending.clear();
  };
  return {
    closed,
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) return reject(fail("browser", "Chrome went away"));
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    disconnect() {
      ws.close();
    },
  };
}
