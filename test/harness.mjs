// The one test seam (spec #21, "Testing Decisions"): run the real
// `shipment-tracker` entry point against a temp state dir, a fixed clock and
// fake transports, then look only at shipments.json, sources.json and events[].
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { main } from "../plugin/cli/main.mjs";

const FIXTURES = new URL("./fixtures/", import.meta.url);

export function fixture(path) {
  return JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8"));
}

// A fake HTTP transport. `routes` maps a DHL tracking number (the `piececode`
// query parameter) to a recorded response: `{ json }`, `{ status, text }`,
// `{ network: true }` for a connection failure, or a function returning a
// Promise of one of those (to hold a request open).
export function fakeDhl(routes) {
  return {
    async fetch(url) {
      const u = new URL(url);
      if (u.host !== "www.dhl.de" || u.pathname !== "/int-verfolgen/data/search") {
        throw Object.assign(new Error(`unexpected request to ${u.host}${u.pathname}`), { code: "unexpected" });
      }
      const code = u.searchParams.get("piececode");
      let r = routes[code];
      if (typeof r === "function") r = await r();
      if (!r) throw Object.assign(new Error(`no recorded response for piececode ${code}`), { code: "unexpected" });
      if (r.network) throw Object.assign(new Error("fake network failure"), { code: "network" });
      return { status: r.status ?? 200, text: r.text ?? JSON.stringify(r.json) };
    },
  };
}

export async function makeWorld({ now = "2026-09-29T10:00:00.000Z", transport = fakeDhl({}) } = {}) {
  const root = await mkdtemp(join(tmpdir(), "shipment-tracker-test-"));
  const env = { HOME: root, XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") };
  const stateDir = join(env.XDG_STATE_HOME, "omarchy-shipment-tracker");
  const world = {
    now: new Date(now),
    transport,
    stateDir,
    logs: [],
    output: [],
    setClock(iso) { world.now = new Date(iso); },
    async run(...argv) {
      return main(argv, {
        env,
        now: () => new Date(world.now),
        transport: world.transport,
        log: (line) => world.logs.push(line),
        out: (line) => world.output.push(line),
      });
    },
    async shipmentsFile() { return JSON.parse(await readFile(join(stateDir, "shipments.json"), "utf8")); },
    async sourcesFile() { return JSON.parse(await readFile(join(stateDir, "sources.json"), "utf8")); },
    async shipment(key) { return (await world.shipmentsFile()).shipments.find((s) => s.key === key); },
    async stateDirMode() { return (await stat(stateDir)).mode & 0o777; },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
  return world;
}
