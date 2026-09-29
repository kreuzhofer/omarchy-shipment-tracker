# Amazon discovery spike: findings

Spike for [Amazon discovery and delivery estimate spike](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/8). Run live on 2026-09-29 against the user's amazon.de account and their Microsoft 365 work mailbox.
- `amazon.mjs`: the browser route.
- `mail.mjs`: the mail route through a pinned `@softeria/ms-365-mcp-server@0.156.2`.

Raw HTML, mail dumps, profiles and tokens live in `~/.local/state/omarchy-shipment-tracker/spike-amazon/` and are never committed. No personal data is quoted here.

## Answer

**Amazon discovery for v1 reads the logged-in order history and each Shipment's progress-tracker page in the user's own Chrome, parked on a hidden Hyprland workspace, and parses the tracker's `page-state` JSON.** Mail from the M365 mailbox is a best-effort second input. It only adds Orders and early Statuses, and it proved essential for one thing: **the user's Amazon orders are split across more than one Amazon account**, and the browser route only sees the account signed into the dedicated profile. v1 should therefore support **one dedicated profile per Amazon account**.

## Browser route: verified live

| Question | Result |
|---|---|
| Does it run unattended, without being challenged? | **Yes, so far.** Login once in a visible window ("Angemeldet bleiben"). Every later run was headful but hidden, with no sign-in, OTP or captcha. A full run is 1 history page plus 3 tracker pages in about 38 s with 4–12 s gaps. Only a handful of runs were made on 2026-09-29, so how long the session lasts is still open. |
| Does Chrome's Wayland app_id follow `--class`? | **Yes.** `class` and `initialClass` were both `ShipmentTrackerChrome`. |
| Can the window be kept off-screen without a config edit? | **Yes.** `hyprctl dispatch 'hl.dsp.window.move({ workspace = "special:shiptracker", follow = false, window = "address:<addr>" })'` (Hyprland 0.56 Lua dispatch) parks it right after launch. It flashes for a moment. A permanent `o.window(...)` rule would avoid the flash in production. |
| Is the hidden window throttled? | **Not in any way that mattered.** Hidden and visible runs produced identical DOMs, 20 s after load. |
| Challenge detection | Logged out, the history URL redirects to `/ap/signin`. This was detected as `needs-login` after 1 page, in 5 s. |
| Encrypted ("CSD") order cards | **Not an obstacle here.** The cards that looked empty were **digital orders** (audiobooks, Prime Video, subscriptions; order IDs start with `D01-`) and correctly have no tracker. All physical orders had a "Lieferung verfolgen" link to `/progress-tracker/package?orderId=…&packageIndex=…&shipmentId=…`. |
| **Tracker `page-state` JSON** (`script[data-a-state*=page-state]`) | **This is the parse target.** It is language-independent and carries: `orderId`, `packageIndex`, `shipmentId`, `trackingId`, `shortStatus` (e.g. `DELIVERED`), `promise.promiseMessage` (e.g. "Zugestellt: 9. September"), `progressTracker.{lastReachedMilestone, numberOfReachedMilestones, lastTransitionPercentComplete}`, `isMfn` (marketplace seller), and `healthyStateIdentifier` / `exceptionStateIdentifier` (**likely the Problem signal**). CSS selectors like `.pt-status-milestone` were **absent** from the current page, so don't rely on them. |
| Carrier | Not in `page-state`. The page text has "DHL" next to "Trackingnummer" for the DHL-carried parcel. The number format also tells: `00340…` / `JJD…` means DHL, `DE…` (12 characters) means Amazon Logistics. |
| **Amazon ↔ DHL match** | **Confirmed.** A marketplace (`isMfn`) Amazon Shipment's `trackingId` equals a Shipment in the user's DHL Sendungsliste, so dedupe keys on the tracking number. |
| Language | The dedicated profile uses German (`de_DE`). With `page-state` as the source, the UI language doesn't matter, so there's no need to force `en_GB`. |
| Ready for pickup wording | **Not observed.** No sample existed today. It stays open, to be caught when it happens. |

## Mail route: verified live

- **Auth:** a device-code login for Softeria's "MS 365 MCP Server" app with `--read-only --enabled-tools '^(list-mail-messages|get-mail-message)$'`, using its own token cache under the widget's state dir. It **succeeded with no consent or admin prompt** on the work tenant.
- **Querying:** a plain listing of the 200 newest mails only spanned about 5 days. `search: "from:amazon.de OR from:dhl.de"` returned 73 relevant mails within 30 days. `$search` can't be combined with `$filter`/`$orderby`, so the date window is applied client-side.
- **The sender addresses map directly to Status:**
  - `bestellbestaetigung@amazon.de` → Announced
  - `versandbestaetigung@` → In transit
  - `shipment-tracking@` → Out for delivery
  - `order-update@` → Delivered
  - `paketankuendigung@dhl.de`, `noreply@dhl.de` and `zustellung@dhl.de` send "ist unterwegs", "kommt heute", "wird gleich zugestellt", "liegt am gewünschten Ablageort" and "verspätet sich".
- **Amazon mail bodies** carry the Order ID, an estimate phrase ("Ankunft heute") and a "Lieferung verfolgen" link. They carry **no Carrier and no tracking number**, as the research predicted.
- **DHL mail subjects** carry the sender name, but not the tracking number in the preview. DHL mail adds nothing over the Sendungsliste.

## Consequences for the strategy ticket

1. Amazon Shipments from **every** Amazon account the user orders with only appear in the browser route if that account has its own dedicated profile. Mail sees all accounts that notify the M365 mailbox, but only at Order level, with a coarse Status and no tracking number.
2. For the DHL-carried subset, the DHL Sendungsliste already delivers full tracking, and the tracking-number match links it to its Order.
3. Mail can serve as an early, cheap trigger ("Bestellt" and "Versendet" arrive before the tracker has much), and as the only source for accounts without a profile.

## Still open

- How long an Amazon session lasts before OTP or sign-in returns. Observe over days, in the same way as the DHL probe.
- Ready for pickup wording, and the Problem values of `exceptionStateIdentifier`.
- Whether the user wants the second Amazon account tracked through the browser too, which needs one more login. The design supports N profiles either way.
