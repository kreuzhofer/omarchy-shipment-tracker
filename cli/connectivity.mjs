// Waiting for the network after a resume (#79). The catch-up run the timer
// fires on resume often starts before Wi-Fi is back, so every request fails
// on the network and the list would stay stale until the next hourly run.
// An offline run instead polls one cheap request with backoff, about two
// minutes in all, and says whether the network came back.
//
// The check is a HEAD request to dhl.de: any HTTP answer means online. It
// carries nothing about the user. No lock is held while waiting.
export const CHECK_URL = "https://www.dhl.de/";
// Seconds to wait before each check: 5 + 10 + 20 + 40 + 45 = 2 minutes.
export const BACKOFF = [5, 10, 20, 40, 45];
const CHECK_TIMEOUT_MS = 10_000;

export async function waitForNetwork({ transport, sleep }) {
  for (const seconds of BACKOFF) {
    await sleep(seconds * 1000);
    try {
      await transport.fetch(CHECK_URL, { method: "HEAD", timeoutMs: CHECK_TIMEOUT_MS });
      return true;
    } catch (e) {
      if (e.code !== "network") throw e;
    }
  }
  return false;
}
