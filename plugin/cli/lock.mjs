// An exclusive flock(2) on a lock file, shared with anything else that locks
// the same file (shell scripts, other CLI runs). Node has no flock binding, so
// a `flock` child process takes the lock and holds it until we close its
// stdin. If this process dies, the pipe closes and the lock is released.
//
// `lockPath` may be a file or a directory. waitSeconds 0 doesn't wait. When
// the lock stays taken, the error has code "locked".
import { spawn } from "node:child_process";

const CONFLICT = 75;

export async function withLock(lockPath, fn, { waitSeconds = 120 } = {}) {
  const wait = waitSeconds === 0 ? ["--nonblock"] : ["--wait", String(waitSeconds)];
  const holder = spawn(
    "flock",
    ["--exclusive", ...wait, "--conflict-exit-code", String(CONFLICT), lockPath, "-c", "echo locked; exec cat >/dev/null"],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const exited = new Promise((resolve) => holder.once("close", resolve));
  await new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.stdout.once("data", () => resolve());
    exited.then((code) => reject(code === CONFLICT
      ? Object.assign(new Error(`${lockPath} is locked`), { code: "locked" })
      : new Error(`could not lock ${lockPath} (flock exited ${code})`)));
  });
  try {
    return await fn();
  } finally {
    holder.stdin.end();
    await exited;
  }
}
