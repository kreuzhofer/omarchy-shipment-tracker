// The real MCP transport for Microsoft 365 mail: the pinned Softeria
// ms-365-mcp-server, installed into the plugin's own folder (plugin/mail-server,
// exact version and lockfile, `npm ci`) the first time it's needed, never
// `npx` latest, and spawned over stdio. Newline-delimited JSON-RPC 2.0.
// Tests replace this with recorded MCP responses (see mail/mcp.mjs).
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withLock } from "../lock.mjs";

const SERVER_DIR = fileURLToPath(new URL("../../mail-server/", import.meta.url));
const ENTRY = `${SERVER_DIR}node_modules/@softeria/ms-365-mcp-server/dist/index.js`;
const REQUEST_TIMEOUT_MS = 120_000;
const INSTALL_WAIT_SECONDS = 300;

const failed = (message) => Object.assign(new Error(message), { code: "server" });
const installed = () => access(ENTRY).then(() => true, () => false);

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.once("error", (e) => resolve({ code: 127, stderr: String(e.message) }));
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

// `npm ci` from the committed lockfile, one installer at a time (a refresh
// and a Login may both need it). keytar's prebuilt binary (Softeria keeps
// its cache key in the keyring with it) is the one install script allowed.
// No bin links: the plugin folder holds no symlinks.
async function ensureInstalled() {
  if (await installed()) return;
  await withLock(SERVER_DIR, async () => {
    if (await installed()) return;
    const result = await run("npm", ["ci", "--omit=dev", "--no-bin-links", "--no-audit", "--no-fund", "--loglevel=error"], SERVER_DIR);
    if (result.code !== 0 || !(await installed())) {
      const offline = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network/i.test(result.stderr);
      throw Object.assign(new Error("npm ci of the mail server failed"), { code: offline ? "network" : "server" });
    }
  }, { waitSeconds: INSTALL_WAIT_SECONDS });
}

export const softeria = {
  async start({ args, env, install = true }) {
    if (install) await ensureInstalled();
    else if (!(await installed())) throw failed("the mail server isn't installed");
    const child = spawn(process.execPath, [ENTRY, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const pending = new Map();
    let nextId = 0;
    let buffer = "";
    let gone = null;
    const fail = (error) => {
      gone ??= error;
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(gone);
      }
      pending.clear();
    };
    child.once("error", (e) => fail(failed(`the mail server didn't start: ${e.message}`)));
    child.once("close", (code) => fail(failed(`the mail server exited (${code})`)));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const waiting = message && pending.get(message.id);
        if (!waiting) continue;
        pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(failed(`MCP error ${message.error.code}`));
        else waiting.resolve(message.result);
      }
    });
    const write = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    return {
      request(method, params) {
        if (gone) return Promise.reject(gone);
        const id = ++nextId;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(failed(`the mail server didn't answer ${method}`));
          }, REQUEST_TIMEOUT_MS);
          pending.set(id, { resolve, reject, timer });
          write({ id, method, params });
        });
      },
      notify(method, params) {
        if (!gone) write({ method, params });
      },
      async close() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = new Promise((resolve) => child.once("close", resolve));
        child.stdin.end();
        child.kill("SIGTERM");
        await closed;
      },
    };
  },
};
