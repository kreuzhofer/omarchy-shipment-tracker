// The real HTTP transport. Tests replace it with recorded responses. Every
// failure to get an HTTP response (DNS, refused, timeout) is code "network".
const TIMEOUT_MS = 30_000;

// Node's fetch sends no cookies and no Referer. Redirects are refused, so an
// image request never leaves the host it was checked for (see images.mjs).
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
  async fetch(url, { method = "GET", headers = {}, body } = {}) {
    let response;
    try {
      response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { status: response.status, text: await response.text() };
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
