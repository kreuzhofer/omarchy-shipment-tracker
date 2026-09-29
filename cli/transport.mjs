// The real HTTP transport. Tests replace it with recorded responses. Every
// failure to get an HTTP response (DNS, refused, timeout) is code "network".
const TIMEOUT_MS = 30_000;

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
};
