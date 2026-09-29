# amazon.de Orders and Shipments

Research for [#4](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/4), part of map [#1](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/1).
Question: what can be learned about a user's recent amazon.de Orders and their Shipments, and how? Covers official APIs, the order-history and track-package pages (fields, URLs, multi-Shipment Orders), login hurdles, and existing open-source tools.

Researched 2026-09-29. Sources are Amazon developer docs, amazon.de help and Conditions of Use pages (fetched logged out), and the source code and issue trackers of five open-source tools. No Amazon account was logged in to. Claims about page markup come from the tools' code, which was written against real logged-in pages. They are second-hand evidence of Amazon's markup, and each one names the tool that relies on it.

## Answer

- **No official customer-facing API exists.** Login with Amazon exposes only `profile`, `profile:user_id` and `postal_code` [1]. SP-API is for sellers and vendors, and its Orders API returns the *selling partner's* orders [2][3]. Every tool below says the same thing: amazon-orders says "Amazon provides no official API" [7], and ha-paketbote says "Amazon bietet keine öffentliche API für Bestell- oder Lieferdaten" [12]. That leaves only the logged-in website (or Amazon's shipping e-mails, see open questions).
- **The Conditions of Use prohibit it.** They forbid "Data Mining, Robots oder ähnliche Datensammel- und Extraktionsprogramme" without Amazon's written consent [4]. Reading your own orders for yourself is a grey area, and account action is a risk we cannot rule out (unverified either way).
- **Two pages carry everything.** (1) *Meine Bestellungen*, `https://www.amazon.de/gp/css/order-history` (current form `/your-orders/orders?timeFilter=…`), lists Order cards with one box per Shipment, a short Status line ("Ankunft …", "In Zustellung", "Zugestellt") and a *Lieferung verfolgen* link [7][10][11]. (2) The **progress tracker**, `https://www.amazon.de/progress-tracker/package/?orderId=…&packageIndex=N&shipmentId=…` (older form: `/gp/your-account/ship-track?…`), shows per Shipment the delivery promise, the main Status, a 4-step milestone bar (Bestellt → Versandt → In Zustellung → Zugestellt), the **Carrier** ("Versendet mit DHL") and the **carrier tracking number** ("Trackingnummer …"). For Amazon Logistics it also shows the live "N Stopps entfernt" count [9][10][11][12].
- **Links and identity.** Order link: `https://www.amazon.de/gp/your-account/order-details?orderID=<order-id>` (order IDs look like `028-1234567-1234567`) [7][8]. Shipment link: the progress-tracker URL. Key a Shipment on `orderId + packageIndex`: `shipmentId` only appears after dispatch [12]. A multi-Shipment Order shows several Shipment boxes, each with its own date and tracking link [5][7][9].
- **Login is the hard part.** amazon.de sign-in can chain: password, "Unified Claim" page, OTP device selection, OTP (TOTP/SMS/WhatsApp), CVF verify, image captcha, AWS WAF challenge, ACIC puzzle, and a "verify you're not a robot / enable JavaScript" page [7][8][10][11]. German users report being asked for a new MFA code after every IP change (the daily Telekom reconnect) or restart [15][16]. No official session lifetime is published (unverified).
- **The tools that hold up drive a real browser.** amazon-orders (Python, requests+BS4) is well maintained, with about 19 releases in the last 12 months [18]. It officially supports only English amazon.com, and it does not read the tracker page [7][13]. ioBroker.parcel and Versand-HA (both amazon.de, requests-based) keep breaking on login changes [15]. ha-paketbote runs a long-lived headful Google Chrome with a persistent profile. The user solves login, MFA and captchas in that browser. It uses CSS selectors first, keys Shipments on `packageIndex`, and caps requests per day [12]. **This matches the Playwright + persistent-profile + "needs-login" approach chosen in #6.**

## Details

### 1. Official APIs

| API | Who it is for | Customer order data? |
|---|---|---|
| Login with Amazon | Any site, for "Sign in with Amazon" | No. Scopes are `profile` (user_id, name, email), `profile:user_id`, `postal_code` [1] |
| Selling Partner API (SP-API) | "sellers and vendors" accessing their business data [2] | No. The Orders API returns the calling seller's orders ("Sellers only") [3] |
| Amazon Shipping / MWS successors | Sellers shipping parcels | No (seller side; not investigated further) |

Conclusion: the "use official APIs unless gatekept" rule from the map falls through to browser automation for Amazon. The Source has no API, gatekept or not.

### 2. Conditions of Use (amazon.de)

The amazon.de *Allgemeine Geschäftsbedingungen / Nutzungsbedingungen* [4] say:

- §3 (Urheberrecht und Datenbankrechte): "Insbesondere dürfen Sie ohne die ausdrückliche schriftliche Zustimmung von Amazon.de kein Data Mining, keine Robots oder ähnliche Datensammel- und Extraktionsprogramme einsetzen, um irgendwelche wesentlichen Teile eines Amazon Services zur Wiederverwendung zu extrahieren".
- §5 (Lizenz und Zugang): the licence excludes "die Nutzung von Data-Mining, Robotern oder ähnlichen Datenerfassungs- und Extraktions-Programmen."

A widget that reads the user's own order status for the user is not reselling Amazon data, but it is literally a "robot". The spec should state this risk to the user in first-run setup. ha-paketbote also advises turning off 1-Click ordering, because a logged-in automated browser can buy things [12].

### 3. Order history page (*Meine Bestellungen*)

URLs:

- `https://www.amazon.de/gp/css/order-history?ref_=nav_orders_first` is the entry point used by the amazon.de tools. It redirects to the current page [10][11].
- `https://www.amazon.de/your-orders/orders?timeFilter=last30|months-3|year-YYYY&startIndex=N` is the canonical history URL in amazon-orders and azad [7][8]. azad appends `&language=en_GB` on amazon.de to get the English UI [8], which would let English-text selectors work. The tool's author has not verified that this is stable.
- Pagination: `ul.a-pagination li.a-last a` [7].

What an Order card holds (selectors from the tools' code; Amazon serves more than one layout, so every tool keeps a list of fallbacks):

| Field | Selector evidence | Notes |
|---|---|---|
| Order card | `div.order-card` / `.order-card.js-order-card` / `div.order` [7][10][11] | Some cards carry `data-order-id` [11] |
| Order ID | `[data-component='orderId']`, `.yohtmlc-order-id …`, or parsed from `orderID=` in links [7][8][11] | Format `\b[A-Z0-9]{3}-\d{7}-\d{7}\b` [12] |
| Order date, total | `[data-component='orderDate']`, `div.yohtmlc-order-total` [7] | |
| Shipment boxes | `[data-component='shipments'] .a-box`, `div.shipment`, `div.delivery-box` [7] | One per Shipment |
| Shipment Status line | `.yohtmlc-shipment-status-primaryText`, `span.delivery-box__primary-text`, `div.js-shipment-info-container div.a-row`, `.od-status-message` [7] | Free text: "Ankunft Freitag", "In Zustellung", "Zugestellt am …" [5][12] |
| Tracking link | `span.track-package-button a`, `a[href*='ship-track?itemId=']`, `a[href*='/progress-tracker/']`, or a button whose text is "Lieferung verfolgen" [7][8][10][11] | Leads to the progress tracker |
| Items | title, ASIN (`/dp/<ASIN>`), image [7][12] | Useful for the row label |

amazon.de help lists these Statuses as shown in *Meine Bestellungen* [5]: **Ankunft** + date (on its way), **In Zustellung** (delivered today), **Geliefert/Zugestellt**, **Nicht zustellbar** (returned to Amazon, refund follows). Non-Amazon Marketplace sellers may not send tracking at all [5][6].

The history page alone does not show the Carrier or the tracking number. It gives a coarse Status and the delivery estimate text only.

### 4. Progress tracker (track-package page)

URL shapes seen in the tools:

- `https://www.amazon.de/progress-tracker/package/ref=ppx_yo_dt_b_track?_encoding=UTF8&orderId=<id>&packageIndex=0&shipmentId=<sid>` [12]
- `https://www.amazon.co.uk/progress-tracker/package/ref=ppx_od_dt_b_track_package?_encoding=UTF8&itemId=…&orderId=…&packageIndex=0&shipmentId=DT7cMbTTr&vt=ORDER_DETAILS` [8]
- Older: `https://www.amazon.de/gp/your-account/ship-track?orderId=<id>&packageIndex=N[&shipmentId=…]` [12]

ha-paketbote's tests record that "Amazon only adds shipmentId once the parcel is dispatched. Keying on it made a parcel change identity mid-life and be filed twice". So it keys on `orderId + packageIndex` [12].

Fields (from ioBroker.parcel [10], Versand-HA [11], ha-paketbote [12] and azad [8], which agree):

| Field | Where | Notes |
|---|---|---|
| Delivery promise / estimate | `.pt-promise-main-slot`, `.pt-promise-details-slot`; JSON `promise.promiseMessage` | e.g. "Ankunft morgen", with a time window when known |
| Main Status | `.pt-status-main-status` (older `.milestone-primaryMessage`, `#primaryStatus`) | Free text |
| Milestone bar | `.pt-status-milestone` with `data-reached`, `data-last-reached`, `data-percent-complete` | 4 steps: ordered, shipped, out for delivery, delivered [12]. Language-independent, best for mapping to our Status |
| Carrier | `.carrierRelatedInfo-mfn-providerTitle` / `#carrierRelatedInfo-container`, text "Versendet mit DHL" | Versand-HA parses the name with the regex `Versendet mit\s+(.+?)` [11] |
| Carrier tracking number | `.pt-delivery-card-trackingId`, text "Trackingnummer JJD…" | Missing for untracked items (Großbrief, some Marketplace sellers) [6]. Versand-HA skips Shipments without one [11] |
| Amazon Logistics live progress | page-state JSON `script[data-a-state='{"key":"page-state"}']` → `mapTracking.calloutMessage`, e.g. "3 Stopps entfernt" | Only on delivery day, once the driver is near; not all carriers [9][10][11][12] |
| Reschedule available | `[class*="RESCHEDULE_DELIVERY"]` | [12] |

Mapping to our Statuses (from Versand-HA's `const.py` and ha-paketbote's `parsing.py`): "zugestellt/geliefert/delivered" → Delivered; "in Zustellung/wird zugestellt/out for delivery" → out for delivery; "versandt/unterwegs" → in transit; "Nicht zustellbar"/return → Returned [5][11][12]. **Ready for pickup** (Amazon Locker / Counter / DHL Packstation) is not handled explicitly by any tool read. Its wording on the tracker is unverified and needs a sample page.

Amazon Logistics is itself a Carrier: "Amazon Logistics arbeitet mit lokalen und regionalen Lieferpartnern … zusammen" [17]. Its Shipments have no DHL counterpart. For them, the Amazon tracker is the only source of progress.

When the Carrier is DHL, the tracking number can also be looked up on DHL. That is the hook for the "match Amazon Shipment to DHL" dedupe question on the map.

### 5. Multi-Shipment Orders

- Help page: "Die einzelnen Artikel einer Bestellung können unterschiedliche Lieferdaten und damit jeweils unterschiedliche Details zum Sendungsverlauf haben … Wenn du mehr als einen Artikel bestellt hast, haben diese Artikel möglicherweise separate Lieferdaten und Sendungsverfolgungsinformationen." [5]
- The order card contains one Shipment box per parcel, each with its own Status line and tracking link. amazon-orders models `Order.shipments[]`, each with `items[]`, `delivery_status` and `tracking_link` [7][13]. azad models `shipment_id`, `status`, `tracking_link` and `tracking_id` per Shipment [8].
- Each tracking link has a distinct `packageIndex` (0, 1, …) [12]. Before dispatch, several items may sit in one box with no tracking link. Versand-HA then creates one placeholder per Order with the status "Bestellt" [11].
- Known parse bugs: amazon-orders #124 ("Order history omits items from a detected multi-item shipment", open, 2026-09-10) and #110 ("Shipments with more than one item parse with no Items", fixed) [14].

### 6. Login hurdles

The sign-in URL used on amazon.de is `https://www.amazon.de/ap/signin?…&openid.assoc_handle=deflex&…&openid.pape.max_auth_age=0&openid.return_to=https://www.amazon.de/gp/css/order-history…` [10][11]. amazon-orders defaults to `assoc_handle=usflex` and does not adjust it per domain [7].

Challenges that the tools handle or detect:

| Challenge | Evidence |
|---|---|
| Password form `form[name='signIn']`, then a "Unified Claim Collection" page | [7][10] |
| MFA device select `form#auth-select-device-form`, OTP `form#auth-mfa-form` (TOTP auto-solvable with the secret) | [7][11] |
| CVF verify `/ap/cvf/verify` via SMS or **WhatsApp** code | [10][11] |
| Image captcha `form.cvf-widget-form-captcha` / `validateCaptcha` | [7][11] |
| AWS WAF JS challenge (`script[src*="awswaf.com"]`); amazon-orders offers paid solver services (CapSolver, 2Captcha, Anti-Captcha) | [7] |
| ACIC puzzle `/ax/aaut/verify/ap/challenge` ("Choose all the buckets") | [7] |
| "verify that you're not a robot … Enable JavaScript" page, which needs a real browser | [7] |
| "untrusted app" warning | [10] |

Session lifetime and re-auth:

- There is no official figure (unverified). amazon-orders treats the `x-main` cookie as the sign of an authenticated session on .com [7]. The amazon.de equivalent was not confirmed.
- amazon-orders #55: "Amazon will sometimes re-prompt for OTP even when a device has been remembered" [14].
- ioBroker.parcel #110 (amazon.de): "Immer wenn sich die IP Adresse (Provider / Fritzbox) ändert, muss ein neuer MFA Code für Amazon eingetragen werden." #42: every nightly restart triggered a new SMS [15].
- ha-paketbote (amazon.de): tick "Angemeldet bleiben" at login, since "Amazon setzt Device-Trust-Cookies nur dann dauerhaft". Keeping one long-lived Chrome profile means "überlebt die Amazon-Session jeden Scheduler-Neustart und jeden Crash". Chrome is never started with `--enable-automation`, so `navigator.webdriver` stays undefined. Google Chrome stable is "der unauffälligste Client" [12].
- amazon-orders troubleshooting: captchas come more often to unknown devices and after failed logins. Turning on 2FA "seems to reduce the frequency of Captcha challenges" [13].

Conclusion: an unattended requests-based login breaks now and then and needs OTP secrets in storage. A persistent real-browser profile that the user signs into once, and that reports `needs-login` when challenged, is the robust choice.

### 7. Open-source tools

| Tool | Stack / scope | Tracker page? | amazon.de? | How it holds up |
|---|---|---|---|---|
| [amazon-orders](https://github.com/alexdlaird/amazon-orders) (Python, MIT) [7] | requests + BeautifulSoup; CLI + library; history, order details, transactions | No; exposes only `tracking_link` and `delivery_status` [13]. #125 "tracking_link is now missing" (open, 2026-09-12) [14] | "Only the English, .com version … officially supported"; `domain=` may work for English sites; German text and € parsing are not supported (#15) [7][14] | Actively maintained: 90 releases total, 19 in the last 12 months [18]. Nightly integration against .com. Breakages are fixed quickly but keep coming (e.g. #66 "Order History completely broken" in 2025-07, #116 CSD-encrypted history pages in 2026-09) [14] |
| [azad](https://github.com/philipmulcahy/azad) Chrome extension (TS) [8] | Runs in the user's logged-in Chrome; no credential handling | Yes: reads `pt-delivery-card-trackingId` | Yes (forces `language=en_GB`) | Tracking data is a paid feature [8]. The extension model does not fit a background widget |
| [ioBroker.parcel](https://github.com/TA2k/ioBroker.parcel) (JS) [10] | axios + JSDOM with full login automation; amazon.de hard-coded | Yes: status, tracking number, carrier, page-state JSON | Yes, German | Long history of login breakage: issues #19, #63, #69, #80, #93, #113, #120, #123 [15] |
| [Versand-HA](https://github.com/Jetiman/Versand-HA) (Python, HA) [11] | aiohttp + BS4 with login automation; amazon.de | Yes, German regexes | Yes | Young (last commit 2026-09-20); same approach as ioBroker, so likely the same fragility (unverified) |
| [ha-paketbote](https://github.com/BobMcGlobus/ha-paketbote) (Python, HA add-on) [12] | Headful Google Chrome in Xvfb, attached over CDP by Playwright; user logs in via noVNC | Yes: milestones, promise, carrier, tracking ID, stop count | Yes | Closest to our plan. Has a "selectors broken" sensor, an LLM fallback extractor, backoff with a request cap (300/day), quiet hours, and 2–5 s jitter between tracker pages [12] |

## Open questions (candidate tickets)

1. **Amazon shipping e-mails as a Source/fallback.** Amazon sends a shipping confirmation with a "Lieferung verfolgen" link [9]. The user uses Microsoft 365 mail. Could Graph API mail parsing discover Amazon Shipments (and their tracker URLs) without scraping the order page at all? ha-paketbote also has a `mail` module [12].
2. **Ready for pickup wording** for Amazon Locker / Counter / Packstation on the tracker page. This needs a real sample page.
3. **Collect sample HTML**, logged in, of history and tracker pages (German UI vs `language=en_GB`) to build fixtures. Decide the UI language used for parsing.
4. **ToS risk acceptance** and how first-run setup presents it (Conditions of Use §3/§5).
5. **Request budget:** hourly refresh × active Shipments means how many tracker-page loads? Should delivered Shipments stop being fetched (a Terminal Status needs no refresh)?

## Sources

1. Login with Amazon, Customer Profile / scopes: https://developer.amazon.com/docs/login-with-amazon/customer-profile.html
2. SP-API, What is the Selling Partner API: https://developer-docs.amazon/sp-api/docs/what-is-the-selling-partner-api
3. SP-API, Orders API: https://developer-docs.amazon/sp-api/docs/orders-api
4. amazon.de Nutzungsbedingungen / Conditions of Use: https://www.amazon.de/gp/help/customer/display.html?nodeId=201909000
5. amazon.de help, Sendung verfolgen: https://www.amazon.de/gp/help/customer/display.html?nodeId=GENAFPTNLHV7ZACW
6. amazon.de help, Fehlende Details zum Sendungsverlauf: https://www.amazon.de/gp/help/customer/display.html?nodeId=G6ZFEB9ZDU7QHMER
7. amazon-orders source (commit 7e6a832, 2026-09-28): `amazonorders/constants.py`, `selectors.py`, `forms.py`, `session.py`, README: https://github.com/alexdlaird/amazon-orders
8. azad source: `src/js/shipment.ts`, `src/js/order_list_page.ts`, `src/js/url.ts`, README: https://github.com/philipmulcahy/azad
9. amazon.de help, Amazon Sendungsverfolgung per Live-Karte: https://www.amazon.de/gp/help/customer/display.html?nodeId=GU9B4LE26DKWVQTN
10. ioBroker.parcel `main.js` (`loginAmz`, `getAmazonOrders`, `getAmazonPackages`): https://github.com/TA2k/ioBroker.parcel/blob/main/main.js
11. Versand-HA `custom_components/paketverfolgung/amazon_api.py`, `const.py`: https://github.com/Jetiman/Versand-HA
12. ha-paketbote README, `paketbote/DOCS.md`, `app/scraper.py`, `app/extractor.py`, `app/parsing.py`, `tests/test_scraper.py`: https://github.com/BobMcGlobus/ha-paketbote
13. amazon-orders docs: `docs/index.rst` (Known Limitations), `docs/troubleshooting.rst`, `docs/waf.rst`, `docs/browser.rst`; `amazonorders/entity/shipment.py`: https://amazon-orders.readthedocs.io
14. amazon-orders issues #15, #55, #66, #110, #116, #124, #125, #134: https://github.com/alexdlaird/amazon-orders/issues
15. ioBroker.parcel issues (search "amazon"), incl. #42, #110, #113, #120, #123: https://github.com/TA2k/ioBroker.parcel/issues?q=amazon
16. ioBroker.parcel #110: https://github.com/TA2k/ioBroker.parcel/issues/110
17. amazon.de help, Lieferungen von Amazon Logistics: https://www.amazon.de/gp/help/customer/display.html?nodeId=GEW3XT9JEMBLTKRV
18. amazon-orders releases: https://github.com/alexdlaird/amazon-orders/releases
