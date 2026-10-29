// The real HTTP transport. Tests replace it with recorded responses. Every
// failure to get an HTTP response (DNS, refused, timeout) is code "network".
const TIMEOUT_MS = 30_000;

// Node's fetch sends no cookies and no Referer. Redirects are refused, so an
// image request never leaves the host it was checked for (see images.mjs).
// `redirect: "manual"` hands a redirect back instead of following it, with
// its `location` and the `cookies` it sets (Set-Cookie values), for a caller
// that keeps a session across the hops (see dpd/search.mjs).
async function readCapped(response, maxBytes) {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export const httpTransport = {
  async fetch(url, { method = "GET", headers = {}, body, redirect = "follow", timeoutMs = TIMEOUT_MS } = {}) {
    let response;
    try {
      response = await fetch(url, { method, headers, body, redirect, signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      if (redirect !== "manual") return { status: response.status, text };
      return { status: response.status, text, location: response.headers.get("location"), cookies: response.headers.getSetCookie() };
    } catch (e) {
      throw Object.assign(new Error(`network: ${e.name}`), { code: "network" });
    }
  },
  // A binary GET: { status, contentType, bytes }, bytes null when the body
  // is over `maxBytes`.
  async fetchBytes(url, { maxBytes, timeoutMs = TIMEOUT_MS } = {}) {
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      const bytes = await readCapped(response, maxBytes);
      return { status: response.status, contentType: response.headers.get("content-type"), bytes };
    } catch (e) {
      throw Object.assign(new Error(`network: ${e.name}`), { code: "network" });
    }
  },
};
