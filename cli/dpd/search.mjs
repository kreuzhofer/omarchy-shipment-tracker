// DPD's public tracking page on my.dpd.de, read anonymously by number (#83):
// no account, no postcode. As seen live, `redirect.aspx?action=12` starts an
// ASP.NET session (a cookie) and redirects through the data-protection page
// to `myparcels/myParcel-tracking.aspx?parcelno=<n>`, which renders the parcel
// server-side only with that session's cookie (without it, it lands on
// `showerror.aspx`). So the redirects are followed here, by hand, carrying
// the cookies; never off my.dpd.de. Node's default user agent, as for every
// request of the tracker.
export const HOST = "my.dpd.de";
const MAX_HOPS = 5;

// DPD parcel numbers are 14 digits.
export const DPD_NUMBER = /^\d{14}$/;

// The page the row opens: the same entry point, which lands a browser on the
// parcel's tracking page.
export function trackingPageUrl(trackingNumber) {
  return `https://${HOST}/redirect.aspx?action=12&parcelno=${encodeURIComponent(trackingNumber)}`;
}

// The cookies a response sets, merged into `jar` (name → value).
function keepCookies(jar, setCookies = []) {
  for (const header of setCookies ?? []) {
    const pair = String(header).split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

// One anonymous lookup. Returns { ok: true, html } with the tracking page, or
// { ok: false, reason } with a failure reason as in sources.json: "network",
// "http" (an HTTP error, a redirect loop or off the host, DPD's error page).
// Whether the page holds a parcel is dpd/status.mjs's question.
export async function lookupDpd(transport, trackingNumber) {
  const jar = new Map();
  let url = trackingPageUrl(trackingNumber);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const headers = jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {};
    let response;
    try {
      response = await transport.fetch(url, { method: "GET", headers, redirect: "manual" });
    } catch (e) {
      if (e.code === "network") return { ok: false, reason: "network" };
      throw e;
    }
    keepCookies(jar, response.cookies);
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) return { ok: false, reason: "http" };
      const next = new URL(response.location, url);
      if (next.protocol !== "https:" || next.host !== HOST) return { ok: false, reason: "http" };
      url = next.href;
      continue;
    }
    if (response.status < 200 || response.status >= 300) return { ok: false, reason: "http" };
    if (/\/showerror\.aspx$/i.test(new URL(url).pathname)) return { ok: false, reason: "http" };
    return { ok: true, html: response.text };
  }
  return { ok: false, reason: "http" };
}
