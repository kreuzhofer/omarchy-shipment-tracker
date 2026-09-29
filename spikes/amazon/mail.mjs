#!/usr/bin/env node
// Throwaway spike for #8: Amazon/DHL mail discovery through a pinned, local,
// read-only Softeria ms-365-mcp-server over MCP stdio (see
// docs/research/m365-softeria-auth.md on branch research/m365-softeria-auth).
//
//   node mail.mjs tools           list the tools and their input schemas
//   node mail.mjs scan [days]     find Amazon/DHL mails, extract Order IDs,
//                                 tracking numbers and Status hints
//
// Token cache and raw results stay in ~/.local/state/omarchy-shipment-tracker/
// spike-amazon/mail/, never in the repo.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(homedir(), ".local/state/omarchy-shipment-tracker/spike-amazon/mail");

function server() {
  const proc = spawn(join(HERE, "node_modules/.bin/ms-365-mcp-server"),
    ["--read-only", "--enabled-tools", "^(list-mail-messages|get-mail-message)$"], {
      env: { ...process.env, MS365_MCP_TOKEN_CACHE_PATH: join(STATE, ".token-cache.json"), MS365_MCP_SELECTED_ACCOUNT_PATH: join(STATE, ".selected-account.json") },
      stdio: ["pipe", "pipe", "pipe"],
    });
  let buf = "";
  let id = 0;
  const pending = new Map();
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
  });
  return {
    async init() {
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shipment-tracker-spike", version: "0" } });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    rpc,
    async call(name, args) {
      const r = await rpc("tools/call", { name, arguments: args });
      const t = r.content?.map((c) => c.text).join("") ?? "";
      try { return JSON.parse(t); } catch { return t; }
    },
    close: () => proc.kill(),
  };
}

const SENDERS = /amazon\.de|dhl\.de|deutschepost\.de/i;
const ORDER_ID = /\b\d{3}-\d{7}-\d{7}\b/g;
const DHL_CODE = /\b(00340\d{15}|JJD\d{15,20}|\d{12}|[A-Z]{2}\d{9}DE)\b/g;
const HINTS = /(versandt|verschickt|unterwegs|in zustellung|zugestellt|geliefert|verspätet|abholbereit|zur abholung|packstation|ankündigung|angekündigt|shipped|out for delivery|delivered|delayed)/gi;

async function scan(days = 30) {
  const s = server();
  await s.init();
  const since = new Date(Date.now() - days * 864e5).toISOString();
  // $search (KQL) cannot be combined with $filter/$orderby, so filter the
  // date client-side.
  const res = await s.call("list-mail-messages", {
    search: '"from:amazon.de OR from:dhl.de"',
    select: ["id", "subject", "from", "receivedDateTime", "bodyPreview"],
    top: 250,
  });
  const messages = (res.value || res.data?.value || []).filter((m) => m.receivedDateTime >= since)
    .sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
  const hits = messages.filter((m) => SENDERS.test(m.from?.emailAddress?.address || ""));
  const rows = hits.map((m) => {
    const blob = `${m.subject} ${m.bodyPreview}`;
    return {
      at: m.receivedDateTime?.slice(0, 10),
      from: m.from?.emailAddress?.address,
      subject: (m.subject || "").slice(0, 70),
      orderIds: [...new Set(blob.match(ORDER_ID) || [])].length,
      trackingNos: [...new Set(blob.match(DHL_CODE) || [])].length,
      hints: [...new Set((blob.match(HINTS) || []).map((h) => h.toLowerCase()))].join(","),
    };
  });
  writeFileSync(join(STATE, `scan-${Date.now()}.json`), JSON.stringify({ total: messages.length, hits }, null, 2), { mode: 0o600 });
  console.log(`messages in window: ${messages.length}, shipping-related: ${hits.length}`);
  console.table(rows);
  // Inspect one Amazon shipping mail body: which fields does it carry?
  const sample = hits.find((m) => /versandbestaetigung|shipment-tracking/.test(m.from?.emailAddress?.address || ""));
  if (sample) {
    const full = await s.call("get-mail-message", { messageId: sample.id, select: ["body"] });
    const body = String(full.body?.content || "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    writeFileSync(join(STATE, `sample-body-${Date.now()}.txt`), body, { mode: 0o600 });
    const links = [...String(full.body?.content || "").matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    console.log("sample body fields:", {
      orderIds: [...new Set(body.match(ORDER_ID) || [])].length,
      trackingNos: [...new Set(body.match(DHL_CODE) || [])].length,
      carrierMention: (body.match(/(DHL|Hermes|DPD|GLS|UPS|Amazon Logistics|Amazon)\b[^.]{0,20}(Zusteller|zugestellt|Versand|liefert)/i) || [null])[0],
      estimate: (body.match(/(Voraussichtliche Zustellung|Zustellung|Lieferung)[^.]{0,40}(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|heute|morgen|\d{1,2}\. \w+)/i) || [null])[0],
      trackerLinks: links.filter((l) => /progress-tracker|ship-track|shiptrack/i.test(l)).length,
      orderDetailLinks: links.filter((l) => /order-details|orderID=|orderId=/i.test(l)).length,
    });
  }
  s.close();
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "tools") {
  const s = server();
  await s.init();
  const r = await s.rpc("tools/list", {});
  for (const t of r.tools) console.log(t.name, JSON.stringify(Object.keys(t.inputSchema?.properties || {})));
  s.close();
} else if (cmd === "scan") {
  await scan(Number(arg) || 30);
} else {
  console.error("usage: node mail.mjs tools | scan [days]");
  process.exit(2);
}
