# dhl.de Sendungsliste: how it loads and whether it can be read automatically

Research for [#3](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/3) (map: [#1](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/1)). Researched 2026-09-29. No DHL account was logged in to. Everything about the logged-in response comes from reading the source of two maintained open-source clients. Those clients were themselves checked against real accounts, but this research did not check them directly.

## Answer

- **One undocumented JSON endpoint returns the list of both Directions:** `GET https://www.dhl.de/int-verfolgen/data/search?noRedirect=true&language=de&cid=app`, sent with no `piececode`. It is authenticated only by a `dhli` cookie that holds an OIDC **ID token**. The response is `{"sendungen":[…], "rateLimited":…}`. Each element carries the tracking number (`id`) and `sendungsinfo.sendungsrichtung`, which gives the Direction: `ANKOMMEND`/`EINGEHEND` for Incoming and `ABGEHEND`/`AUSGEHEND` for Outgoing. It also carries `sendungsinfo.sendungsliste`, whose values are `AKTUELL` and `ARCHIVIERT`, and `sendungsdetails.sendungsverlauf`. That field holds a 0–5 progress ladder (`fortschritt`/`maximalFortschritt`), the status text and the events. There are also delivery-window fields and Packstation pickup hints.
- **Login uses DHL's Akamai CIAM OIDC** at `login.dhl.de`, with Authorization Code and PKCE. The client is a DHL-app `client_id` whose redirect is `dhllogin://de.deutschepost.dhl/login`. The user logs in once in a real browser, including any 2FA, and copies the `dhllogin://…?code=` redirect URL. After that everything runs headless over HTTP: an ID/access token lives **1800 s**, and it is refreshed with an `offline_access` refresh token. The refresh token's own lifetime is **not documented** (unverified). Both clients handle an expired or revoked refresh token by asking the user to log in again.
- **Feasibility is good but fragile.** Two maintained clients, [ha-parcel-integrations/ha-dhl](https://github.com/ha-parcel-integrations/ha-dhl) (Home Assistant) and [TA2k/ioBroker.parcel](https://github.com/TA2k/ioBroker.parcel), do exactly this today. They report these failure modes:
  - The wrong `client_id`, or a missing `claims`/`post_number` claim, returns an **empty list with HTTP 200**, which looks exactly like an empty account.
  - A refreshed token can silently lose the account link.
  - Requests must come from a **German IP**.
  - Akamai bot-manager cookies can cause timeouts.
  - The login method has changed at least once before (2024/25).
- **Direct HTTP with a stored refresh token is clearly better than browser automation.** A browser is only needed for the one-time interactive login, and it can be a human-driven browser. Driving the list page with headless Chrome would have to fight Akamai bot detection and 2FA on every run.
- **ToS:** the private-customer terms (AGB DHL Empfangs- und Versandoptionen) contain **no explicit anti-automation clause** that could be found. They do make the customer responsible for keeping credentials and access data secret. The **business** portal terms explicitly forbid robots and scrapers. The endpoint and `client_id` are undocumented and not licensed for third-party use, so DHL could break or block them at any time. The official DHL APIs only look up **by tracking number** and cannot list an account's Shipments.

## Details

### 1. What the list is (official description)

- DHL's help pages describe the Kundenkonto as giving "an overview at all times over all already delivered and still outstanding parcels" ([DHL help: customer account – general](https://www.dhl.de/en/privatkunden/hilfe-kundenservice/themen/kundenkonto/allgemein.html), via search snippet, not fetched directly).
- **How a Shipment gets into the list:** DHL matches it by address, or by a Postnummer the sender transmits. If a Shipment is missing, the help page says: "Based on the address we could not assign this shipment to your customer account and the sender did not send a post number electronically to DHL". Users can then add tracking numbers by hand ([DHL help: customer account – usage](https://www.dhl.de/en/privatkunden/hilfe-kundenservice/themen/kundenkonto/nutzung.html)). The AGB add that matching uses the email address and/or mobile number the sender passes to DHL ([AGB DHL Empfangs- und Versandoptionen, Ziffer 2(1)–(2)](https://www.dhl.de/agb-paketempfang-neu)).
- **Archive:** delivered Shipments move to an archive "a few weeks after the delivery". The archive holds delivered parcels "from the last 80 days". Users can delete entries from "My Shipments". Registered mail (Einschreiben) does not appear ([nutzung.html](https://www.dhl.de/en/privatkunden/hilfe-kundenservice/themen/kundenkonto/nutzung.html)).
- The web page "Meine Sendungen" is `https://www.dhl.de/de/privatkunden/dhl-sendungsverfolgung.html` ([DHL help nav](https://www.dhl.de/de/privatkunden/hilfe-kundenservice/themen/kundenkonto.html)).
- **Unverified:** I could not confirm without logging in whether the web page loads the same `int-verfolgen/data/search` endpoint, without `cid=app`, using a web-issued `dhli` cookie. Both OSS clients use the app variant.

### 2. Endpoint and data shape

**Endpoint.** `GET https://www.dhl.de/int-verfolgen/data/search` with the parameters `noRedirect=true&language=de&cid=app` ([ha-dhl `const.py` L135](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/const.py#L135), [ioBroker `main.js` L1642-1651](https://github.com/TA2k/ioBroker.parcel/blob/ee0015ed42714b62e5d02be56de269112a6e4e76/main.js#L1642-L1651)).
- Leaving out `piececode` makes it the **account inbox**, the Sendungsliste. Adding `piececode=<n>` (ioBroker sends a comma-joined list) makes it a by-number lookup. ha-dhl notes: "One JSON endpoint serves both models … `noRedirect=true` is required — without it the endpoint has been observed to answer 303" ([const.py L130-135](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/const.py#L130-L135)).
- ioBroker uses two steps. It reads the inbox, keeps the `id`s that are not `ARCHIVIERT`, and then fetches the details with `piececode=<ids>` ([main.js L1651-1681](https://github.com/TA2k/ioBroker.parcel/blob/ee0015ed42714b62e5d02be56de269112a6e4e76/main.js#L1651-L1681)). ha-dhl reads the inbox directly. It enriches only "bare stub" elements that have no `sendungsverlauf`, using a by-number call ([`countries/de/__init__.py` `needs_enrichment` L219](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/countries/de/__init__.py#L219)).

**Auth carrier.** The OIDC `id_token` goes in a cookie named `dhli`, not in an `Authorization` header ([const.py L140-143](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/const.py#L140-L143); ioBroker sets `dhli=<id_token>` for `dhl.de` and `www.dhl.de`, [main.js L214-215](https://github.com/TA2k/ioBroker.parcel/blob/ee0015ed42714b62e5d02be56de269112a6e4e76/main.js#L214-L215)). The headers are plain iPhone-style `accept`, `user-agent` and `accept-language` values. A bare request with no User-Agent "stalls until timeout" ([const.py L145-158](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/const.py#L145-L158)).

**Verified by me, unauthenticated:** calling the inbox URL with no cookie returns HTTP 200 `application/json` with the body `{"sendungen":[],"mergedAnonymousShipmentListIds":[],"rateLimited":false}`. So **"not logged in" looks exactly like "no Shipments"**. The widget must detect a lost session some other way, for example by checking the token and its claims.

**Element fields** used by ha-dhl ([`countries/de/__init__.py`](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/countries/de/__init__.py)), mapped to our vocabulary:

| Field | Meaning | Our term |
|---|---|---|
| `id` | tracking number (piece code) | Shipment identity |
| `sendungsinfo.sendungsrichtung` | `ANKOMMEND`/`EINGEHEND` = in, `ABGEHEND`/`AUSGEHEND` = out ([L369-373](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/countries/de/__init__.py#L369-L373)). `ABGEHEND` was seen on a real account; `AUSGEHEND` only in other OSS code. | Direction |
| `sendungsinfo.sendungsname` | the sender (Incoming) or recipient (Outgoing), HTML-escaped | row label |
| `sendungsinfo.sendungsliste` | `AKTUELL` or `ARCHIVIERT` ([L173-208](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/countries/de/__init__.py#L173-L208)) | archive filter |
| `sendungsdetails.sendungsverlauf.fortschritt` / `maximalFortschritt` | 0–5 ladder: 0–1 registered, 2–3 in transit, 4 out for delivery, 5 delivered ([L261-275](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/countries/de/__init__.py#L261-L275); ioBroker maps it the same way except 2 = "in preparation", [main.js L2310-2317](https://github.com/TA2k/ioBroker.parcel/blob/ee0015ed42714b62e5d02be56de269112a6e4e76/main.js#L2310-L2317)) | Status |
| `sendungsverlauf.status`, `kurzStatus`, `datumAktuellerStatus`, `events[].{datum,status}` | free-text status (localised HTML) and history | Status text |
| `sendungsdetails.istZugestellt` | delivered flag | Terminal Status (Delivered) |
| `sendungsdetails.retoure` / `ruecksendung` | return flags ([L736-743](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/countries/de/__init__.py#L736-L743)) | Returned (while it is on the way back) |
| `sendungsdetails.zustellung.{zustellzeitfensterVon,zustellzeitfensterBis,zustellzeitfenster,zustelldatum}` | delivery window or estimate; exact shape still contested ([L628](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/countries/de/__init__.py#L628)) | estimate |
| `zustellung.packageStationType == "PACKAGE_STATION"` and `abholcodeAvailable == true` | parcel waiting in a Packstation ([L447](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/countries/de/__init__.py#L447)) | Ready for pickup |

**Known gaps** (from the ha-dhl README and code):
- A parcel waiting in a **Filiale** cannot be told apart from one that is out for delivery ([README "Troubleshooting"](https://github.com/ha-parcel-integrations/ha-dhl#troubleshooting); [open issue #7](https://github.com/ha-parcel-integrations/ha-dhl/issues/7)).
- The ladder is confirmed for Incoming Shipments only. ha-dhl deliberately reports `unknown` for Outgoing ones ([L485-504](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/countries/de/__init__.py#L485-L504)).
- ioBroker instead watches the text of the free-text status, for example "zur Abholung bereit" ([ioBroker issue #22](https://github.com/TA2k/ioBroker.parcel/issues/22)).

### 3. Login flow

- **Identity provider:** Akamai CIAM OIDC. The issuer is `https://login.dhl.de/af5f9bb6-27ad-4af4-9445-008e7a5cddb8/login` ([ha-dhl `session.py` docstring](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/countries/de/session.py#L1-L27)). **Verified by me:** the public discovery document at `…/login/.well-known/openid-configuration` lists the `authorize` and `token` endpoints, the grant types `authorization_code`, `refresh_token` and others, and the auth methods `client_secret_basic` and `client_secret_post`.
- **Client:** `client_id=83471082-5c13-4fce-8dcb-19d2a3fca413`, `redirect_uri=dhllogin://de.deutschepost.dhl/login`, `scope=openid offline_access`, plus a `claims` parameter that requests `post_number`, `twofa` and other claims. The token endpoint uses Basic auth with an **empty secret** and a DHL-app User-Agent (`DHLPaket_PROD/1367 CFNetwork/…`) ([const.py L79-117](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/const.py#L79-L117); the same values are hardcoded in [ioBroker `lib/dhlLogin.js`](https://github.com/TA2k/ioBroker.parcel/blob/ee0015ed42714b62e5d02be56de269112a6e4e76/lib/dhlLogin.js) and in its [admin login link](https://github.com/TA2k/ioBroker.parcel/blob/ee0015ed42714b62e5d02be56de269112a6e4e76/admin/index_m.html#L128)).
- **Setup-time pitfalls from ha-dhl:**
  - The **current** DHL Paket app's public client "authenticates fine but gets an empty account-inbox listing back".
  - Without the `post_number` claim the inbox comes back empty.
  - The ha-dhl docs say: "Do not change any of these four without a live re-test" ([ARCHITECTURE.md "Authentication"](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/ARCHITECTURE.md#authentication)).
- **The interactive step:**
  1. The user opens the authorize URL in a desktop browser.
  2. The user logs in, including 2FA if it is enabled on the account.
  3. The browser fails to open `dhllogin://…` and stalls.
  4. The user copies the full `dhllogin://…?code=…&state=…` URL from DevTools → Network ("Preserve log").
  5. The code is single-use and short-lived ([ha-dhl `docs/finding-the-redirect-url.md`](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/docs/finding-the-redirect-url.md)).

  2FA is therefore handled by the human in the browser and is never automated.
- **Session lifetime:** the token response has `expires_in: 1800`. ha-dhl refreshes 5 minutes before expiry and forces one refresh after a 401 ([const.py L118-120](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/const.py#L118-L120), [session.py L60-62, L341](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/countries/de/session.py#L60-L62)). The refresh token **may rotate** and must be saved again after each refresh. A token request that stalls can burn the refresh token ([ARCHITECTURE.md "Transport quirks"](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/ARCHITECTURE.md#transport-quirks)). ioBroker logs "Refresh token expired. Bitte einen neuen dhllogin:// Code …" when the refresh fails ([main.js L2753](https://github.com/TA2k/ioBroker.parcel/blob/ee0015ed42714b62e5d02be56de269112a6e4e76/main.js#L2753)). **The absolute lifetime of the refresh token is unknown (unverified).** Neither project states it.
- **Silent account-link loss:** a refreshed ID token can lose the `post_number` claim. The inbox then returns an empty list. ha-dhl detects this and forces the user to log in again ([session.py `_async_refresh`](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/countries/de/session.py#L341-L370)). A user saw exactly this symptom, and a fresh login fixed it ([ha-dhl issue #6](https://github.com/ha-parcel-integrations/ha-dhl/issues/6)).
- **Bot protection and geo-restriction:**
  - ioBroker deletes the Akamai Bot Manager cookies `_abck`, `ak_bmsc` and `bm_sz` before each poll, because stale ones "cause ECONNRESET/ETIMEDOUT" ([main.js L1630-1640](https://github.com/TA2k/ioBroker.parcel/blob/ee0015ed42714b62e5d02be56de269112a6e4e76/main.js#L1630-L1640)).
  - The ioBroker maintainer says DHL "blockiert ab eine bestimmte Anzahl pro Stunde" (blocks after a certain number of requests per hour) ([issue #91](https://github.com/TA2k/ioBroker.parcel/issues/91)). The response also has a `rateLimited` flag.
  - ha-dhl says the endpoint only answers requests from **German IPs** ([README "Requirements"](https://github.com/ha-parcel-integrations/ha-dhl#requirements)).
  - An hourly poll, as the brief asks for, is well within what these clients do. ha-dhl's default is 30 minutes ([const.py L118-120 comment](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/custom_components/dhl/const.py#L118-L120)).

### 4. Open-source clients and how they hold up

| Project | Approach | State |
|---|---|---|
| [ha-parcel-integrations/ha-dhl](https://github.com/ha-parcel-integrations/ha-dhl) (Python, HA custom component) | OIDC with a pasted code, per-login PKCE, refresh token, `dhli` cookie, inbox plus by-number lookup | Created 2026-08-31, pushed 2026-09-28, pre-release, 3 stars. It is the most careful implementation, with every contested field logged and guarded. Its known bugs are Filiale pickup and account-link loss after refresh. |
| [TA2k/ioBroker.parcel](https://github.com/TA2k/ioBroker.parcel) (Node) | The same client and endpoints, but with a **hardcoded** PKCE verifier and challenge ([lib/dhlLogin.js](https://github.com/TA2k/ioBroker.parcel/blob/ee0015ed42714b62e5d02be56de269112a6e4e76/lib/dhlLogin.js)) | Maintained since 2022, 23 stars. Its history shows the login breaking: a Janrain-based email/password and SMS/2FA-code login stopped working in Dec 2024–Feb 2025 ([#90](https://github.com/TA2k/ioBroker.parcel/issues/90), [#94](https://github.com/TA2k/ioBroker.parcel/issues/94)). An "alternative" browser-code login followed in 0.2.10 (2025-01) and became the `dhllogin://` code login in 0.3.0/0.3.1 (2026) ([README changelog](https://github.com/TA2k/ioBroker.parcel#changelog)). There are recurring timeout issues ([#65](https://github.com/TA2k/ioBroker.parcel/issues/65), [#91](https://github.com/TA2k/ioBroker.parcel/issues/91)). |
| [kabelsalatundklartext/selfdashboard parcel plugin](https://github.com/kabelsalatundklartext/selfdashboard/tree/main/plugins-pack/parcel) | Anonymous by-number lookup on the same endpoint only | No account list, so it does not help with discovery. |

ha-dhl says it cross-checked its field mapping against "three OSS clients", one of them "Versand-HA". These are referenced in [ARCHITECTURE.md](https://github.com/ha-parcel-integrations/ha-dhl/blob/818c6b10af5fa3f2af1c192b86e51d155a9feddb/ARCHITECTURE.md), but its underlying research notes are in a private repo. I did not find any other maintained client for the account list.

### 5. Browser automation vs direct HTTP

- **Direct HTTP plus a stored refresh token (recommended).** The steady state needs no browser, cookie jar or JavaScript, just one GET per poll plus a token refresh. The risks are:
  - DHL retires the app `client_id`. ha-dhl logs this case as `invalid_client`.
  - The refresh token expires or loses its account link, which forces a new interactive login.
  - The endpoint changes shape.

  All three would show up as "login expired" or "source down" errors in the widget.
- **Browser automation** (headless Chrome on `dhl-sendungsverfolgung.html`) would need a logged-in browser profile. It would have to get past Akamai Bot Manager, which fingerprints headless browsers, and would face 2FA again whenever the web session ends. It gains nothing, because the data comes from the same JSON either way (unverified for the web page, see §1). It is only useful as a fallback if the app client is ever shut off.
- **One-time login UX:** users would copy the redirect URL from DevTools the way ha-dhl and ioBroker ask, or the Omarchy setup could catch the `dhllogin://` redirect itself. Possible ways: register an `x-scheme-handler/dhllogin` `.desktop` handler, or use the Chrome DevTools Protocol. **Untested idea:** Chrome may not hand over custom schemes that come from a redirect without a user gesture.

### 6. ToS implications

- **Private-customer terms:** the [AGB DHL Empfangs- und Versandoptionen](https://www.dhl.de/agb-paketempfang-neu) (PDF, read in full via text extraction) cover the Kundenkonto and the "Internetplattform" (website and Post & DHL App). I found **no clause about robots, scraping or automated access**. The customer must keep the platform access data secret and bears the risk of misuse, "insbesondere im Falle der Weitergabe an Dritte" (especially if they are passed on to third parties) (Ziffer 4(11), 5(1)). A local tool that stores the user's own refresh token on their own machine does not pass anything to a third party. This is my reading, not legal advice.
- **Business portal terms**, for comparison: they explicitly forbid "robots, spiders, scrapers, data-mining tools … or other automated means" ([Post & DHL Geschäftskundenportal Nutzungsbedingungen](https://www.dhl.de/dam/jcr:a9593c30-9430-429a-bf2e-1f82753d7eca/dhl-post-und-dhl-geschaeftskundenportal-nutzungsbedingungen.pdf), via search snippet). They do not apply to a private account, but they show where DHL stands.
- **Using the app's `client_id`** means impersonating DHL's own app client. That is not authorised anywhere. ha-dhl's own disclaimer says it "may rely on public, unofficial, or undocumented carrier interfaces … may be subject to DHL's terms" ([README](https://github.com/ha-parcel-integrations/ha-dhl#disclaimer)).
- **Official alternatives cannot list an account's Shipments:**
  - [Shipment Tracking – Unified](https://developer.dhl.com/api-reference/shipment-tracking) looks up by tracking number only. It allows 250 calls/day by default, and approval requires a company name.
  - [Parcel DE Tracking (Post & Paket Deutschland)](https://developer.dhl.com/api-reference/dhl-paket-de-sendungsverfolgung-post-paket-deutschland) looks up 15–20 numbers per query. It needs Business Customer Portal credentials obtained through a DHL sales contact.

  So for discovery the official API is effectively **gatekept**, and by the map's source rule we fall back to the unofficial endpoint. The official Unified API could still serve Status refreshes for numbers the user adds by hand.

## Open questions surfaced

1. **Refresh-token lifetime:** how often will the user need to log in again? Unknown. It needs a long-running prototype.
2. **Can Omarchy/Chrome catch the `dhllogin://` redirect automatically** (scheme handler or CDP), so the user does not have to use DevTools?
3. **Outgoing Status ladder:** does `fortschritt` mean the same thing for `ABGEHEND` Shipments? Unconfirmed in every source.
4. **Ready for pickup at a Filiale:** is there a field that tells this apart from out for delivery? This is an open issue upstream.
5. **Session loss:** how should the widget tell "session lost" from "no Shipments", given that both return `sendungen: []` with HTTP 200?
6. **Letter advice:** is `int-aviseanzeigen/advices` (Briefankündigung, used by ioBroker) in scope? Probably out of scope for Shipments.
