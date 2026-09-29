# DHL discovery spike: findings

Spike for [DHL discovery spike](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/7). Run live against the user's dhl.de account on 2026-09-29. The script is `dhl.mjs` in this folder. Raw responses and tokens live in `~/.local/state/omarchy-shipment-tracker/spike-dhl/` and are never committed.

## Answer

**DHL discovery for v1 should read the dhl.de Sendungsliste over plain HTTP with a stored, rotating refresh token.** The user logs in once through DHL's app login in a dedicated Chrome profile, and the `dhllogin://` redirect is caught automatically over CDP.

- It works: 15 Shipments came back, each with a tracking number, Direction, 0–5 progress, Status text, events, the delivery window and pickup flags.
- A full refresh costs two requests.
- No browser is needed after login.
- The official Unified Tracking API is not needed (it is out of scope anyway).
- The same endpoint without a login answers by-number lookups for manual add.

## What was verified live

| Question | Result |
|---|---|
| Does ha-dhl's auth still work? | **Yes.** It uses client `83471082-…`, the `claims` parameter with `post_number`, an empty Basic secret and PKCE. The token response has `access_token, refresh_token, expires_in (1800), token_type, scope, id_token`. The `post_number` claim is present. |
| Can Omarchy catch the `dhllogin://` redirect itself? | **Yes, over CDP.** The spike launches `google-chrome-stable --user-data-dir=<dedicated profile> --remote-debugging-port=9333 <authorize URL>`, auto-attaches to page targets, and matches `dhllogin://…` in any CDP event. It arrived in `Network.responseReceivedExtraInfo`, the raw 302 headers. The window closes itself and the user never touches DevTools. The only step for the user is logging in. |
| Does the refresh token rotate? | **Yes.** It changed on the very first refresh (`rotated: true`), so it must be saved again after every refresh, atomically, before anything else happens. |
| Stub elements | The inbox call returns full details only for some current Shipments. The rest, including all `ARCHIVIERT` ones, come back as stubs with `hasCompleteDetails: false`. **An authenticated `piececode=<id,id,…>` call returns the whole inbox again, complete for exactly the codes asked for**, so asking for every id returns the full list in one call. Asking for only the stubs turns the previously complete ones back into stubs. |
| Response stability | Two back-to-back inbox calls returned identical lists, including the same set of complete and stub elements. |
| History depth | The archive reached back to 2026-07-06, which is enough for the 30-day window. |
| Delivery estimate | `zustellung.zustellzeitfensterVon/Bis` holds a day window (e.g. `2026-09-30..2026-09-30`) while the Shipment is in transit. |
| Amazon via DHL | An Amazon parcel (a `JJD…` tracking number, sender name "Amazon") shows up as a normal Incoming DHL Shipment. Matching Amazon to DHL can therefore key on the carrier tracking number from Amazon's tracker page. |
| German IP | The spike ran from a German IP, as the endpoint requires. Not tested from abroad. |
| Anonymous lookup | `piececode=<n>` without the `dhli` cookie answers HTTP 200, so the manual-add path needs no login. A made-up number returned an empty stub. |

## Status fields seen (for the Status model ticket)

- `sendungsverlauf.fortschritt` / `maximalFortschritt`: seen values 1/5 ("Sendung elektronisch angekündigt"), 2/5 ("Vorbereitung für Weitertransport") and 5/5 ("Zustellung erfolgreich").
- `sendungsverlauf.status` is a short German text. `events[]` carry `datum`, `ort` and a long `status` text, plus a per-event `ruecksendung` flag.
- `sendungsdetails.istZugestellt` is the delivered flag. `retoure` / `ruecksendung` are the return flags.
- `zustellung` flags: `abholcodeAvailable`, `benachrichtigtInFiliale` (**likely the Filiale Ready for pickup signal, the upstream gap; unconfirmed until a live case appears**), `hasPickupLocationMismatch`, `hasDeliveryDateMismatch`.
- `sendungsdetails.quelle` (`PAKET`), `kleinpaket`, `paeckchen`, `expressSendung`, `international`, `zielland`.
- `kurzStatus` never appeared, so don't rely on it.

## Still open (observed over time, not blocking the route decision)

A systemd user timer, `shipment-tracker-dhl-probe.timer`, runs `probe` hourly (`Persistent=true`) and appends one JSON line to `probe.log`. It saves raw evidence whenever an Outgoing, Filiale, Packstation or return element appears.

1. **How long the refresh token lasts** before the user must log in again.
2. **Whether the progress ladder means the same for Outgoing Shipments.** The account had none on 2026-09-29.
3. **Whether `benachrichtigtInFiliale` signals Filiale pickup**, and how a Packstation pickup looks.
4. **Telling "logged out" from "no Shipments":** the spike treats a refreshed ID token without `post_number`, or a failed refresh, as logged out. A real empty account couldn't be tested.

To remove the probe: `systemctl --user disable --now shipment-tracker-dhl-probe.timer && rm ~/.config/systemd/user/shipment-tracker-dhl-probe.*`.
