#!/usr/bin/env node
// Throwaway spike for "Amazon discovery and delivery estimate spike" (#8).
// Not production code.
//
// Drives the installed Google Chrome with a dedicated profile over a fixed CDP
// port, per docs/research/low-detection-automation.md (branch
// research/low-detection-automation): headful, no automation flags, never
// Runtime.enable, HTML read with DOM.getOuterHTML and parsed in Node.
//
//   node amazon.mjs login     visible window; the user signs in ("Angemeldet
//                             bleiben"); closes once the order history loads
//   node amazon.mjs fetch     hidden window; order history + up to 6 tracker
//                             pages; prints Shipments, saves raw HTML locally
//
// Profile, raw HTML and results live in ~/.local/state/omarchy-shipment-tracker/
// spike-amazon/, never in the repo.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as cheerio from "cheerio";

const STATE = join(homedir(), ".local/state/omarchy-shipment-tracker/spike-amazon");
const PROFILE = join(STATE, "chrome-profile");
const PORT = 9334;
const CLASS = "ShipmentTrackerChrome";
const HISTORY_URL = "https://www.amazon.de/gp/css/order-history?ref_=nav_orders_first";
const MAX_TRACKER_PAGES = 6;
mkdirSync(STATE, { recursive: true, mode: 0o700 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(4000 + Math.random() * 8000);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// ---- Chrome + Hyprland

function launchChrome() {
  const chrome = spawn("google-chrome-stable", [
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, "--password-store=gnome-libsecret",
    `--class=${CLASS}`, "--no-first-run", "--no-default-browser-check", "about:blank",
  ], { stdio: "ignore", detached: true });
  chrome.unref();
  return chrome;
}

function hyprClients() {
  return JSON.parse(execFileSync("hyprctl", ["clients", "-j"], { encoding: "utf8" }));
}

async function findWindow(pid) {
  for (let i = 0; i < 40; i++) {
    const w = hyprClients().find((c) => c.pid === pid || c.class === CLASS);
    if (w) return w;
    await sleep(250);
  }
  return null;
}

function hideWindow(w) {
  const lua = `hl.dsp.window.move({ workspace = "special:shiptracker", follow = false, window = "address:${w.address}" })`;
  try { execFileSync("hyprctl", ["dispatch", lua], { encoding: "utf8" }); } catch {}
}

// ---- minimal CDP client (no Runtime domain, ever)

async function cdp() {
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(200); }
  }
  if (!wsUrl) throw new Error("Chrome DevTools endpoint did not come up");
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  return {
    ws,
    targetId: page.targetId,
    async navigate(url) {
      const loaded = new Promise((r) => {
        const l = (msg) => { if (msg.method === "Page.loadEventFired" && msg.sessionId === sessionId) { listeners.splice(listeners.indexOf(l), 1); r(); } };
        listeners.push(l);
      });
      await send("Page.navigate", { url }, sessionId);
      await Promise.race([loaded, sleep(30000)]);
      await sleep(1500);
    },
    async url() {
      return (await send("Target.getTargetInfo", { targetId: page.targetId })).targetInfo.url;
    },
    async html() {
      const { root } = await send("DOM.getDocument", { depth: -1 }, sessionId);
      return (await send("DOM.getOuterHTML", { nodeId: root.nodeId }, sessionId)).outerHTML;
    },
    async close() {
      try { await send("Browser.close"); } catch {}
      ws.close();
    },
  };
}

// ---- page classification and parsing

function challengeOf(url, html) {
  if (/\/ap\/(signin|cvf|mfa)|\/ap\/challenge|validateCaptcha|\/errors\//.test(url)) return `challenge-url:${new URL(url).pathname}`;
  if (/captcha|Geben Sie die angezeigten Zeichen ein|Bestätigen Sie, dass Sie kein Roboter sind/i.test(html) && !/order-card|your-orders/.test(html))
    return "challenge-content";
  return null;
}

const text = ($el) => $el.text().replace(/\s+/g, " ").trim();

function parseHistory(html) {
  const $ = cheerio.load(html);
  const orderIds = [...new Set((html.match(/\b\d{3}-\d{7}-\d{7}\b/g) || []))];
  const trackers = [];
  $("a[href*='progress-tracker'], a[href*='ship-track']").each((_, a) => {
    const href = new URL($(a).attr("href"), "https://www.amazon.de").toString();
    const u = new URL(href);
    const box = $(a).closest(".a-box, .delivery-box, .shipment, [data-component='shipments']");
    trackers.push({
      orderId: u.searchParams.get("orderId") || u.searchParams.get("orderID"),
      packageIndex: u.searchParams.get("packageIndex"),
      shipmentId: u.searchParams.get("shipmentId"),
      boxStatus: text(box.find(".yohtmlc-shipment-status-primaryText, .delivery-box__primary-text, .od-status-message").first()) ||
        text(box).slice(0, 120),
      href,
    });
  });
  const unique = [...new Map(trackers.map((t) => [`${t.orderId}#${t.packageIndex}#${t.shipmentId}`, t])).values()];
  return { orderIds, trackers: unique, title: $("title").text().trim() };
}

function parseTracker(html) {
  const $ = cheerio.load(html);
  const milestones = [];
  $(".pt-status-milestone, [class*='milestone']").each((_, m) => {
    const el = $(m);
    milestones.push({
      label: text(el).slice(0, 40),
      reached: el.attr("data-reached") ?? null,
      last: el.attr("data-last-reached") ?? null,
      percent: el.attr("data-percent-complete") ?? null,
    });
  });
  const body = text($("body"));
  const carrier = (body.match(/(?:Versendet mit|Lieferung durch|Zusteller|Shipped with|Delivery by)\s*:?\s*([A-Za-zÄÖÜäöü .-]{2,30})/) || [])[1]?.trim() || null;
  const tracking = text($(".pt-delivery-card-trackingId")) || (body.match(/(?:Trackingnummer|Tracking ID)\s*:?\s*([A-Z0-9]{8,30})/) || [])[1] || null;
  let pageState = null;
  const stateScript = $("script[data-a-state*='page-state']").first().html();
  if (stateScript) { try { pageState = JSON.parse(stateScript); } catch {} }
  return {
    promise: text($(".pt-promise-main-slot")) || null,
    promiseDetail: text($(".pt-promise-details-slot")) || null,
    mainStatus: text($(".pt-status-main-status, .milestone-primaryMessage, #primaryStatus").first()) || null,
    milestones: milestones.slice(0, 8),
    carrier,
    tracking: tracking ? String(tracking).replace(/^(Trackingnummer|Tracking ID)\s*/i, "") : null,
    mapCallout: pageState?.mapTracking?.calloutMessage ?? null,
    pageStateKeys: pageState ? Object.keys(pageState) : [],
  };
}

// ---- commands

async function login() {
  const chrome = launchChrome();
  const browser = await cdp();
  await browser.navigate(HISTORY_URL);
  console.log("A Chrome window (class ShipmentTrackerChrome) shows amazon.de. Sign in, tick 'Angemeldet bleiben', and it closes once your orders appear.");
  for (let i = 0; i < 600; i++) {
    const url = await browser.url();
    if (/amazon\.de\/(gp\/css\/order-history|your-orders)/.test(url) && !/\/ap\//.test(url)) {
      await sleep(2000);
      const html = await browser.html();
      if (!challengeOf(url, html)) {
        console.log("Signed in; order history reached.");
        await browser.close();
        return;
      }
    }
    await sleep(2000);
  }
  await browser.close();
  throw new Error("timed out waiting for sign-in");
}

async function fetchAll() {
  const started = Date.now();
  const chrome = launchChrome();
  const win = await findWindow(chrome.pid);
  if (win) hideWindow(win);
  const after = win ? hyprClients().find((c) => c.address === win.address) : null;
  const browser = await cdp();
  const out = { at: new Date().toISOString(), window: { class: win?.class, initialClass: win?.initialClass, workspace: after?.workspace?.name }, pages: 0 };
  try {
    await browser.navigate(HISTORY_URL);
    out.pages++;
    let url = await browser.url();
    let html = await browser.html();
    writeFileSync(join(STATE, `history-${stamp()}.html`), html, { mode: 0o600 });
    const ch = challengeOf(url, html);
    if (ch) { out.state = "needs-login"; out.challenge = ch; return out; }
    const history = parseHistory(html);
    out.history = { title: history.title, orderIds: history.orderIds.length, trackerLinks: history.trackers.length };
    out.shipments = [];
    for (const t of history.trackers.slice(0, MAX_TRACKER_PAGES)) {
      await jitter();
      await browser.navigate(t.href);
      out.pages++;
      url = await browser.url();
      html = await browser.html();
      writeFileSync(join(STATE, `tracker-${t.orderId}-${t.packageIndex}-${stamp()}.html`), html, { mode: 0o600 });
      const ch2 = challengeOf(url, html);
      if (ch2) { out.state = "needs-login"; out.challenge = ch2; break; }
      out.shipments.push({ orderId: t.orderId, packageIndex: t.packageIndex, shipmentId: t.shipmentId, boxStatus: t.boxStatus, ...parseTracker(html) });
    }
    out.state ??= "ok";
    return out;
  } finally {
    out.seconds = Math.round((Date.now() - started) / 1000);
    writeFileSync(join(STATE, `result-${stamp()}.json`), JSON.stringify(out, null, 2), { mode: 0o600 });
    await browser.close();
  }
}

// Experiment: do encrypted (CSD) order cards decrypt with time, and does the
// hidden special workspace throttle that? `history [visible]`
async function historySettle() {
  const visible = process.argv.includes("visible");
  const chrome = launchChrome();
  const win = await findWindow(chrome.pid);
  if (win && !visible) hideWindow(win);
  const browser = await cdp();
  try {
    await browser.navigate(HISTORY_URL);
    for (let t = 0; t <= 20; t += 2) {
      const $ = cheerio.load(await browser.html());
      const cards = $(".order-card, .js-order-card");
      let withId = 0;
      cards.each((_, c) => { if (/\d{3}-\d{7}-\d{7}/.test($(c).text())) withId++; });
      console.log(`t+${t}s visible=${visible} cards=${cards.length} decrypted=${withId} trackerLinks=${$("a[href*='progress-tracker']").length}`);
      if (withId === cards.length) break;
      await sleep(2000);
    }
    writeFileSync(join(STATE, `history-settled-${stamp()}.html`), await browser.html(), { mode: 0o600 });
  } finally {
    await browser.close();
  }
}

const [cmd] = process.argv.slice(2);
const commands = {
  history: historySettle,
  login,
  fetch: async () => console.log(JSON.stringify(await fetchAll(), null, 2)),
};
if (!commands[cmd]) {
  console.error("usage: node amazon.mjs login | fetch");
  process.exit(2);
}
commands[cmd]().catch((e) => {
  console.error("error:", e.message || e);
  process.exit(1);
});
