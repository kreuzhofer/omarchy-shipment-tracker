// DHL's `int-verfolgen/data/search` endpoint (undocumented; see the
// prototype/dhl-discovery branch, spikes/dhl/FINDINGS.md). Without the `dhli`
// cookie it answers anonymous by-number lookups, which serve manual adds.
// Requires a German IP.
export const SEARCH_URL = "https://www.dhl.de/int-verfolgen/data/search";
const SEARCH_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  "accept-language": "de-de",
};

export function trackingPageUrl(trackingNumber) {
  return `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${encodeURIComponent(trackingNumber)}`;
}

// One anonymous lookup. Returns { ok: true, element } with the raw element for
// this number, or { ok: false, reason } with a Health reason
// ("network" | "http" | "shape" | "rate-limited").
export async function lookupAnonymous(transport, trackingNumber) {
  const params = new URLSearchParams({ noRedirect: "true", language: "de", cid: "app", piececode: trackingNumber });
  let response;
  try {
    response = await transport.fetch(`${SEARCH_URL}?${params}`, { method: "GET", headers: SEARCH_HEADERS });
  } catch (e) {
    if (e.code === "network") return { ok: false, reason: "network" };
    throw e;
  }
  if (response.status < 200 || response.status >= 300) return { ok: false, reason: "http" };
  let data;
  try {
    data = JSON.parse(response.text);
  } catch {
    return { ok: false, reason: "shape" };
  }
  if (!data || !Array.isArray(data.sendungen)) return { ok: false, reason: "shape" };
  if (data.rateLimited === true) return { ok: false, reason: "rate-limited" };
  const element = data.sendungen.find((s) => s?.id === trackingNumber || s?.sendungsinfo?.gesuchteSendungsnummer === trackingNumber)
    ?? (data.sendungen.length === 1 ? data.sendungen[0] : undefined);
  if (!element) return { ok: false, reason: "shape" };
  return { ok: true, element };
}
