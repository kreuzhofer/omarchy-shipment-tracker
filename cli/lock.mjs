// An exclusive flock(2) on a lock file, shared with anything else that locks
// the same file (shell scripts, other CLI runs). Node has no flock binding, so
// a `flock` child process takes the lock and holds it until we close its
// stdin. If this process dies, the pipe closes and the lock is released.
import { spawn } from "node:child_process";

export async function withLock(lockPath, fn, { waitSeconds = 120 } = {}) {
  const holder = spawn(
    "flock",
    ["--exclusive", "--wait", String(waitSeconds), lockPath, "-c", "echo locked; exec cat >/dev/null"],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const exited = new Promise((resolve) => holder.once("close", resolve));
  await new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.stdout.once("data", () => resolve());
    exited.then((code) => reject(new Error(`could not lock the state dir (flock exited ${code})`)));
  });
  try {
    return await fn();
  } finally {
    holder.stdin.end();
    await exited;
  }
}
