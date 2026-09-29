#!/usr/bin/env node
// Entry point: `shipment-tracker <command>`. See main.mjs.
import { execFile } from "node:child_process";
import { main } from "./main.mjs";
import { httpTransport } from "./transport.mjs";

const exec = (file, args) => new Promise((resolve) => {
  execFile(file, args, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
});

const code = await main(process.argv.slice(2), {
  env: process.env,
  now: () => new Date(),
  transport: httpTransport,
  log: (line) => console.error(line),
  out: (line) => console.log(line),
  exec,
}).catch((e) => {
  // Never log a tracking number, even from an unexpected error message.
  console.error(`error: ${String(e.message).replace(/\d{3}-\d{7}-\d{7}|[A-Za-z0-9]*\d[A-Za-z0-9]{7,}/g, "…")}`);
  return 1;
});
process.exitCode = code;
