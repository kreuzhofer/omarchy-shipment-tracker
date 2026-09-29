// Talking to the pinned Softeria ms-365-mcp-server over MCP (spec #21,
// "Source adapters · Microsoft 365 mail"; route (b) of #15).
//
// The server always runs read-only with only the two mail read tools, so it
// asks Microsoft for Mail.Read (plus User.Read and the OIDC defaults) and
// nothing else. Its token cache, selected-account file and logs live in
// <state dir>/mail/ (mode 700; Softeria writes the files 600, and a Login
// tightens them again). The cache's encryption key stays where Softeria keeps
// it, in the keyring. Softeria's own auth tools (login, verify-login,
// logout) are always registered in stdio mode; `--enabled-tools` only limits
// the Graph tools.
//
// The transport (deps.mcp) starts the server and speaks JSON-RPC to it:
//   mcp.start({ args, env, install }) → { request(method, params), notify(method, params), close() }
// It fails with code "server" when the server can't be installed or started,
// or dies. Tests replace it with recorded MCP responses.
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export const ENABLED_TOOLS = "^(list-mail-messages|get-mail-message)$";
export const SERVER_ARGS = ["--read-only", "--enabled-tools", ENABLED_TOOLS];

export function mailPaths(stateDir) {
  const dir = join(stateDir, "mail");
  return {
    dir,
    tokenCache: join(dir, "token-cache.json"),
    selectedAccount: join(dir, "selected-account.json"),
    logDir: join(dir, "logs"),
  };
}

// Starts the server with a fresh log dir (Softeria's logs hold only the
// last run) and does the MCP handshake. `install`: the transport may install
// the pinned server first when it's missing. Softeria asks Graph for text
// bodies; `html: true` starts it asking for HTML ones (MS365_MCP_BODY_FORMAT),
// which only the item ladder reads (see connection.mjs).
export async function openServer(mcp, stateDir, { install = true, html = false } = {}) {
  const paths = mailPaths(stateDir);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await chmod(paths.dir, 0o700);
  await rm(paths.logDir, { recursive: true, force: true });
  const server = await mcp.start({
    args: SERVER_ARGS,
    env: {
      MS365_MCP_TOKEN_CACHE_PATH: paths.tokenCache,
      MS365_MCP_SELECTED_ACCOUNT_PATH: paths.selectedAccount,
      MS365_MCP_LOG_DIR: paths.logDir,
      ...(html ? { MS365_MCP_BODY_FORMAT: "html" } : {}),
    },
    install,
  });
  try {
    await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "shipment-tracker", version: "1" },
    });
    server.notify("notifications/initialized", {});
  } catch (e) {
    await server.close().catch(() => {});
    throw e;
  }
  return {
    // A tool's answer: { isError, text, json } (json: the text parsed, or undefined).
    async tool(name, args = {}) {
      const result = await server.request("tools/call", { name, arguments: args });
      const text = (result?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("");
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { isError: result?.isError === true, text, json };
    },
    close: () => server.close(),
  };
}

// What Softeria logged about a failed silent token refresh in this run
// ("Silent token acquisition failed: <MSAL error>"): its tool answer only
// says that it failed, not whether the network was down.
export async function lastAuthDetail(stateDir) {
  const text = await readFile(join(mailPaths(stateDir).logDir, "error.log"), "utf8").catch(() => "");
  const lines = text.split("\n").filter((l) => /Silent token acquisition failed:/.test(l));
  return lines.at(-1) ?? "";
}

// Credential files are only readable by the user.
export async function tightenFiles(stateDir) {
  const paths = mailPaths(stateDir);
  for (const file of [paths.tokenCache, paths.selectedAccount]) {
    await chmod(file, 0o600).catch((e) => { if (e.code !== "ENOENT") throw e; });
  }
}

export async function removeFiles(stateDir) {
  const paths = mailPaths(stateDir);
  for (const file of [paths.tokenCache, paths.selectedAccount]) await rm(file, { force: true });
  await rm(paths.logDir, { recursive: true, force: true });
}
