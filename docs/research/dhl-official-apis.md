# DHL official APIs: access, quota, Statuses, account Shipment lists

Research for [#2](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/2). Sources checked 2026-09-29 on developer.dhl.com (the legacy portal `entwickler.dhl.de` now 301-redirects to `developer.dhl.com/post-und-dhl-deutschland`).

## Answer

| API | Verdict | Why |
|---|---|---|
| **Shipment Tracking – Unified** (`api-eu.dhl.com/track/shipments`) | **Usable with limits** | You get a free key after DHL reviews the app by hand. The review asks for a company name, which is a risk for a private user (not verified). The starting quota is 250 calls/day and 1 call per 5 s. It covers DHL Paket Germany (`parcel-de`) by tracking number, so it works for both Directions. The coarse `statusCode` can't tell Ready for pickup or Returned apart, but the parcel-de event codes (`LA`/`ZF`) and `returnFlag` can. It can't discover Shipments: you need to know the tracking number first. |
| **Shipment Tracking – Unified Push** (webhooks) | **Not usable** | It needs a public HTTPS webhook, and parcel-de supports subscriptions per Shipment only, not per Account. |
| **DHL Parcel DE Shipment Tracking** (XML, `parcel/de/tracking/v0`) | **Gatekept** | You need login credentials from a DHL sales contact or a Business Customer Portal user. |
| **Any API that lists the Shipments in a dhl.de customer account** (Sendungsliste, Paketankündigung) | **Does not exist (as far as public docs show)** | None of the Post & Parcel Germany APIs in the catalog lists a private account's Shipments. The APIs that come closest (Shipping v2, Returns, Postnumber, the login-walled MyAccount API) are for business customers (EKP) and don't list incoming parcels. Paketankündigung is delivered only by e-mail and in the app. |

**What this means for the widget:** DHL has no official way to *discover* Shipments. Discovery has to come from somewhere else, such as Paketankündigung e-mails, the Post & DHL app or website through browser automation, Amazon, or manual add. Once a tracking number is known, the Unified API is a sound official way to *track* it, provided each user registers their own key.

---

## 1. Shipment Tracking – Unified API

Page: <https://developer.dhl.com/api-reference/shipment-tracking>. OpenAPI spec v1.5.8: <https://developer.dhl.com/sites/default/files/2026-08/track_v1.5.8.yaml>

### Getting a key

- To get a key, you create an app in the portal, add "Shipment Tracking – Unified", and submit it. DHL then reviews it: "If you have valid user credentials, your request will be approved. We will check that your user does not have bot-like credentials, as well as a valid company name in your profile. Ideally, your email domain should match your company name." DHL allows up to 2 instances per user, one for production and one for testing. "Additional verification steps may be required for some applications." ([page, *Get Access*](https://developer.dhl.com/api-reference/shipment-tracking))
- Authentication is a single header, `DHL-API-Key: <consumer key>`. There's no OAuth and no user login. ([page, *Authentication*](https://developer.dhl.com/api-reference/shipment-tracking))
- The portal terms of use allow a natural person over 18 to register ("'You' … means you if you act as a natural person being older than 18 years, or the entity you are authorized to represent"). API keys are confidential to the registrant ("You are solely responsible for the confidentiality of your API (Productive) Keys"), and "Without our prior consent you may not grant third parties access to your account." ([General Developer Portal Terms of Use](https://developer.dhl.com/terms-use)) **So:** the widget shouldn't ship a shared key. Each user registers their own key and enters it as a setting.
- **Unverified:** whether DHL approves a private individual whose profile has no company name. The docs only say they check for "a valid company name". Only a real application will settle this.

### Quota and rate limits

- "Upon your initial request for access … you will receive a service level allowing **250 calls per day, with a maximum of 1 call every 5 seconds**. This limit is intended for initial development and is not suitable for production use." You can ask for more with "Request Upgrade" in My Apps. Going over the limit returns HTTP 429. ([page, *Rate limits*](https://developer.dhl.com/api-reference/shipment-tracking))
- Sizing for this widget: an hourly refresh means 24 rounds a day, so 250 calls/day covers about 10 Shipments that aren't Terminal yet, polled every hour. That's enough for one person if Terminal Shipments are no longer polled. Calls within a refresh must be at least 5 s apart. One call can carry one `trackingNumber`. The spec has no batch parameter; `offset`/`limit` page through matches for a single number ([spec, parameters](https://developer.dhl.com/sites/default/files/2026-08/track_v1.5.8.yaml)).
- The sandbox server is `https://api-sandbox.dhl.com/track` ([spec, `servers`](https://developer.dhl.com/sites/default/files/2026-08/track_v1.5.8.yaml)). Since 2023-06-27, "Try Now" and the demo key return mocked responses ([page, changelog "Demo-key – usage change"](https://developer.dhl.com/api-reference/shipment-tracking)).

### Coverage: DHL Paket Germany, Incoming and Outgoing

- Scope under "Post & Parcel Germany" includes "… Warenpost National, **Paket**" ([page, *Scope*](https://developer.dhl.com/api-reference/shipment-tracking)). The `service` enum includes `parcel-de` ([spec, `Service`](https://developer.dhl.com/sites/default/files/2026-08/track_v1.5.8.yaml)).
- The only operation is `GET /shipments?trackingNumber=…` ([spec, `paths`](https://developer.dhl.com/sites/default/files/2026-08/track_v1.5.8.yaml)). The lookup goes by tracking number and ignores who is asking, so **Incoming and Outgoing work the same way**. You can't list or search by account.
- `recipientPostalCode`: "For our parcel services in Germany, you can add recipientPostalCode to your query. This will provide you with more detailed information about the shipment." ([page, *DHL Parcel queries*](https://developer.dhl.com/api-reference/shipment-tracking)). Since v1.5.0, "all places are secured and protected by challenge (postal-code) in default" ([page, changelog 1.5.0](https://developer.dhl.com/api-reference/shipment-tracking)). For Incoming, that's the user's own postal code. For Outgoing, it's the recipient's postal code, which the user knows because they sent the parcel. (The sibling Parcel DE Tracking docs say that for online returns you need the *sender's* postal code instead: [Parcel DE Tracking page](https://developer.dhl.com/api-reference/dhl-parcel-de-shipment-tracking-post-parcel-germany).)
- `language` sets the response language ([spec](https://developer.dhl.com/sites/default/files/2026-08/track_v1.5.8.yaml)).
- Heads-up: DHL rolled out a new parcel-de backend on 2026-08-20 and reverted it on 2026-08-21 after a performance problem. It will come back later. It changes timestamps (to ISO 8601 with offset), event texts, the product field and the service URLs. DHL advises: "we strongly recommend using structured status codes instead of free-text descriptions." ([page, *Notifications* 12-08-2026 and 21-08-2026](https://developer.dhl.com/api-reference/shipment-tracking))

### What the response contains

From the spec ([track_v1.5.8.yaml](https://developer.dhl.com/sites/default/files/2026-08/track_v1.5.8.yaml)):

- `shipment.status` and each entry of `shipment.events[]` carry `timestamp`, `location`, `statusCode`, `status`, `statusDetailed`, `description`, `remark` and `nextSteps`.
- `statusCode` is a **coarse enum with 5 values: `pre-transit`, `transit`, `delivered`, `failure`, `unknown`**.
- Estimated delivery comes in `estimatedTimeOfDelivery`, `estimatedDeliveryTimeFrame {estimatedFrom, estimatedThrough}`, `estimatedTimeOfDeliveryRemark` and `agreedDeliveryDate`. For parcel-de: "EDD (Estimate Date of Delivery) including time window has been enabled for parcel_de shipments" (changelog 01.Jul.2024, [page](https://developer.dhl.com/api-reference/shipment-tracking)).
- `returnFlag` is a boolean: "A flag whether the delivery is returned back to consignor". It was added in 1.4.2 "to mark the shipment as rejected or returned".
- `serviceUrl` is a link to the DHL tracking page and can serve as the Source's detail page. `rerouteUrl` is also present.
- For parcel-de, `status` holds a short event code: "Under 'status' you will receive a set of codes e.g. 'ZU'. The current content of 'status' is moved to 'remark'" (changelog 29.Apr.2024, [page](https://developer.dhl.com/api-reference/shipment-tracking)).

**parcel-de event codes.** They come from DHL's CSV [status_1.csv](https://developer.dhl.com/sites/default/files/2024-10/status_1.csv), rows for `parcel-de`:

| Code | Meaning (DHL text) | Maps to our Status |
|---|---|---|
| VA | Electronic pre advise of a shipment | pre-transit (label created) |
| ES | First processed by DHL, e.g. handover by customer to a DHL facility | in transit |
| AA / EE / NB | Departed from / Arrived at / Normal processing | in transit |
| PO | In delivery process | out for delivery |
| **LA** | In storage, e.g. **waiting for pickup by receiver** | **Ready for pickup** (see below) |
| **ZF** | Delivery to agency / postal office / **Packstation** | **Ready for pickup** |
| ZN | Delivery attempt not successful | exception |
| ZU | Delivery successful | Delivered |
| AE / AN | Pickup (from sender) successful / not successful | Outgoing handover |
| BV / ZO / DD / GT | Exception / customs / data service / money transfer | informational |

A finer mapping from DHL's internal "ICE" event/reason codes to these codes is in [parcel_de_ice_event_ric_combinations_July_2024.csv](https://developer.dhl.com/sites/default/files/2024-08/parcel_de_ice_event_ric_combinations_July_2024.csv). For example:

- `HLDCC` "Held for consignee collection / Sendung liegt zur Abholung bereit" maps to LA/ZF. Its reasons include Packstation (`LDPCK`), Service Point / Filiale (`SERPT`), and not collected by the end of the storage period (`NTCCN`).
- `CNRFC` "Consignee notified – Ready for collection" maps to ZF, with reasons PCKST (Packstation) and SERPT (Filiale/Agentur).
- `DLVRD/ACCPK` "Collected from automated site / Sendung aus Packstation entnommen" maps to ZU.
- `RETRN/*` "Shipment will be returned to origin / Rücksendung" maps to ZN or BV, with reasons such as refused, not collected, bad address, moved.
- `DSPSD/*` "Disposed of / Vernichtung" maps to **ZU**. Watch out: a disposed parcel also carries ZU.

### Ready for pickup and Returned: can they be told apart?

- **Ready for pickup: yes, via the event code rather than `statusCode`.** `LA` and `ZF` in `status` mark a parcel held at a Packstation or Filiale. `statusCode` stays `transit` (**inferred, not verified with a live key**). The pickup location (`servicePoint`, `address`) needs `recipientPostalCode`. One catch: `LA` also covers other kinds of storage, such as holiday storage or a sender's hold request (`INFCL/*`). Also `ZF` covers some non-pickup cases (e.g. `EXPHD/CLREF`, customs refused). A precise rule would need the ICE detail, and **it's unverified whether UTAPI exposes ICE codes** (`statusDetailed` might hold them).
- **Returned: partly.** `returnFlag=true` marks a Shipment that is being returned or rejected, and `RETRN` events carry ZN/BV codes. **Unverified:** what `statusCode` and `status` look like once the returned parcel reaches the sender. It is probably `delivered`/`ZU` with `returnFlag=true`, so the widget should treat `returnFlag && delivered` as **Returned**. Test this with a real return.
- `ZU` also covers `DSPSD` (disposed of). Leaving that edge case aside is fine for v1.

### Terms that affect the widget

These come from "Legal Terms specifics for the use of Tracking Data" ([page](https://developer.dhl.com/api-reference/shipment-tracking)):

- Tracking Data may be used only "for Your own or Your customers' legitimate tracking purposes". It is confidential: don't pass it to third parties.
- "Unless otherwise agreed, You shall **delete the Tracking Data 30 days after the delivery**." This fits the widget's 30-day window. Cache retention must not go beyond it.
- "Display '**Delivered by Deutsche Post DHL Group**' in text (minimum font size) as soon as it is presented/submitted to recipient and/or Your customers." Whether this applies when the user is the sender or recipient themselves is **unclear**. Adding a small footer line in the popup is the cheap, safe option.
- If you are neither the sender nor the consignee, you need their consent. That doesn't apply when the user tracks their own parcels.

## 2. Other official DHL tracking APIs

- **Shipment Tracking – Unified Push** ([page](https://developer.dhl.com/api-reference/shipment-tracking-unified-push)). DHL POSTs events to "your system", which must "use a valid SSL certificate and reply … with a HTTP 200 response within 5 seconds". The subscription table lists `parcel-de` as Shipment **yes** and Account **no**. Account subscriptions "require Business approval". **Not usable:** a desktop widget has no public HTTPS endpoint, and this API can't discover Shipments by account either.
- **DHL Parcel DE Shipment Tracking** (XML `d-get-piece-detail`, [page](https://developer.dhl.com/api-reference/dhl-parcel-de-shipment-tracking-post-parcel-germany)). It has a "public" query (15 numbers per call, last 3 months) and a "business" query (limited to the business customer's own Shipments). For the public query, "please contact your DHL sales contact person to obtain a user ID and password". Production needs a "User of the Post & DHL Business Customer Portal". Estimated delivery needs a "separate right". **Gatekept.** The same page documents the direct link `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=<nr>`, which suits the "open the Source's detail page" action.

## 3. Is there an API that lists a dhl.de account's Shipments (Sendungsliste / Paketankündigung)?

**No public API exists.** Here is what was checked:

- **The full API catalog** ([developer.dhl.com/api-catalog](https://developer.dhl.com/api-catalog), all pages). These are the Post & Parcel Germany entries:
  - Authentication
  - Datafactory Autocomplete
  - E-POST Hybrid Mail
  - Deutsche Post International
  - Internetmarke
  - Order Management
  - Print Mailing (2)
  - Parcel DE Pickup (2)
  - Parcel DE Postnumber
  - Parcel DE Private Shipping
  - Parcel DE Returns
  - Parcel DE Shipment Tracking
  - Mail Communication Tracking Push
  - Parcel DE Shipping v2
  - Products API

  None of them offers a "list the Shipments of a customer account" operation.
- **Parcel DE Shipping v2** ([spec](https://developer.dhl.com/sites/default/files/2026-05/parcel-de-shipping-v2.yaml)) has `/orders`, `/labels` and `/manifests`. It creates and fetches labels for a business customer with an EKP. There's no list of incoming parcels.
- **Parcel DE Private Shipping** ([page](https://developer.dhl.com/api-reference/dhl-parcel-de-private-shipping-post-parcel-germany), [spec](https://developer.dhl.com/sites/default/files/2026-03/DHL%20Parcel%20DE%20Private%20Shipping-v1_1.yaml)) is for *partners* that fill a DHL Online Franking cart. Its endpoints read back carts that the partner created: `/shopping-carts/{id}`, and labels by PAKID or shipment number. It can't list a private user's own Outgoing Shipments made on dhl.de or in the app.
- **Parcel DE Postnumber** ([page](https://developer.dhl.com/api-reference/dhl-parcel-de-postnumber-post-parcel-germany)) needs "A valid business customer contract with DHL Paket GmbH". It only checks a name against a Postnummer and "may only be used for the purpose of preparing shipments to DHL Packstations".
- **MyAccount API.** The Authentication API lists it among the APIs that use its token ([Authentication API page](https://developer.dhl.com/api-reference/authentication-api-post-parcel-germany)). Its reference page `…/myaccount-api-post-parcel-germany` redirects to the portal login, so it's not public. The same Authentication API page says production use needs "credentials for the business customer portal". **Not verified** what it offers. All the evidence points to business-customer account data, not the private dhl.de Sendungsliste.
- **Paketankündigung** ([dhl.de page](https://www.dhl.de/de/privatkunden/pakete-empfangen/sendungen-verfolgen/paketankuendigung.html)) is delivered by e-mail and in the Post & DHL app to registered account holders, and covers Incoming parcels only. The page mentions no API or export. Its e-mails could be a discovery source for Incoming Shipments (see the mail-based tickets).

## Open points / not verified

1. Whether DHL approves a Unified API key for a private individual without a company. Only an application will tell.
2. The real parcel-de responses: whether `statusDetailed` carries ICE codes, what a Returned Shipment looks like at the end (`returnFlag` + `ZU`?), and whether Ready for pickup sets `statusCode=transit`. Settle this with a live key and real Shipments.
3. Whether the "Delivered by Deutsche Post DHL Group" display requirement applies to personal use.
4. What the MyAccount API is (it's behind the login).
