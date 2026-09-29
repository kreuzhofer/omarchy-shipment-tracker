# Microsoft 365 mail as a Shipment discovery source

Research for [#5](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/5). Sources checked 2026-09-29. The user's mailbox was not read. Everything about email contents comes from public docs, public help pages, and the test fixtures and patterns of an open-source parser.

The user has confirmed that the mailbox is in a **work/school (Entra ID) tenant**, so that case is the focus here. Personal Outlook.com accounts get a short note in §4.

## Answer

- **Technically yes, organisationally probably gatekept.** Delegated Microsoft Graph `Mail.Read` (or IMAP with OAuth2) can read the DHL and amazon.de emails a desktop tool needs. The permissions reference still lists delegated `Mail.Read` as *AdminConsentRequired: No*. But from late October 2025, the **Microsoft-managed default consent policy** blocks user consent for `Mail.Read`, `Mail.ReadBasic`, `IMAP.AccessAsUser.All` and related permissions. It is the default for new tenants and was rolled out to existing ones. **In a tenant with default settings, the user cannot consent for our own app by themselves. An admin has to approve it.** The exceptions are tenants whose admin picked the legacy "Allow user consent for apps" setting, and a short allow-list of popular mail clients (Thunderbird, Apple Mail, eM Client, …).
- **No clean shortcut through a public client ID.** Microsoft publishes no first-party "public" client ID that a third-party tool may use for mail. The only IDs that skip the new block are the allow-listed mail clients. Reusing Thunderbird's client ID (`9e5f94bc-…`) would probably get past the consent screen. But the tool would then pose as Thunderbird in the tenant's sign-in logs, and depends on another vendor's registration. It is technically possible but not recommended (§2.4).
- **IMAP is no easier than Graph.** IMAP is enabled per mailbox by default, but admins can turn it off per mailbox. `IMAP.AccessAsUser.All` is on the same blocked list, and Conditional Access "block legacy/other clients" policies often cover it. Graph is the better route: REST, `$search`/`$filter`, and no XOAUTH2 plumbing.
- **Flow:** auth code + PKCE with a `http://localhost` loopback redirect in the system browser (Chrome) is preferred. Microsoft tells admins to block device code flow "as close as possible to unilaterally" with Conditional Access. Ask for `offline_access`: refresh tokens last 90 days and are replaced on every use, so an hourly refresh stays signed in until someone revokes access.
- **What to ask the tenant admin** (the smallest request that works): *"Please register a single-tenant public-client app 'Shipment Tracker' (or let me register it) with delegated Microsoft Graph permissions `User.Read`, `Mail.Read`, `offline_access`, a Mobile/desktop redirect URI `http://localhost`, and grant admin consent, either tenant-wide or only for my user (oauth2PermissionGrant with consentType `Principal`). Please also make sure Conditional Access allows it from my Linux laptop."* Alternatively, they can turn on the admin consent workflow so the user can file the request from the consent screen. See §2.5.
- **Email contents (all Incoming, except label purchases):**
  - **DHL** emails come from `noreply@dhl.de` (display name "DHL Paket"). They carry the tracking number (at least in link query strings such as `piececode=00340…`), the sender's name in the subject when the shop provided it, the expected delivery day or a same-day time window, and delivered notices. They go only to registered dhl.de customers, and not for Packstation deliveries, small parcels, or returns.
  - **amazon.de** emails (`versandbestaetigung@amazon.de` and others) carry the **Order ID** (`\d{3}-\d{7}-\d{7}`), the Status in the subject (`Versandt:`, `In Zustellung:`, `Zugestellt:`/`Geliefert:`) and an estimate (`Zustellung: …`). Current templates **do not name the Carrier or the carrier tracking number**; they only link to Amazon's progress tracker (inferred from recent non-.de fixtures, **unverified for .de**).
  - **Outgoing** (Paketmarke purchase) confirmations contain a label download button and a QR code. Whether they include the tracking number in text is **unverified**.
- **Consequence for the map:** mail can discover Incoming DHL and amazon.de Shipments well. It is weak for Outgoing and for Carrier/tracking of Amazon Shipments, and it can only be used after an admin approves it in this tenant.

---

## 1. Microsoft Graph route

### 1.1 Permission and API

- `GET /me/messages` (or `/me/mailFolders/{id}/messages`) lists the signed-in user's messages. Least-privileged delegated permission: `Mail.ReadBasic`, higher: `Mail.Read`, for both work/school and personal accounts. Page size is 1 to 1000 (default 10). Bodies come back as HTML unless you send `Prefer: outlook.body-content-type="text"`. When `$filter` and `$orderby` are combined, the properties must appear in the same order, or the call fails with `InefficientFilter`. ([List messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0))
- `$search` on messages accepts KQL properties such as `from:`, `subject:`, `received:` and `body:`, and returns up to 1,000 results. Example: `$search="from:noreply@dhl.de OR from:amazon.de"`. ([$search](https://learn.microsoft.com/en-us/graph/search-query-parameter))
- `Mail.ReadBasic` leaves out the body. Amazon subjects alone carry the Order ID and Status, but DHL subjects don't carry the tracking number (§5), so `Mail.Read` is needed. Also, `Mail.ReadBasic` is on the same blocked list (§2.2), so asking for less doesn't avoid admin consent.
- Delegated `Mail.Read`: *AdminConsentRequired: No* in the permissions reference, and it "is available for consent in personal Microsoft accounts". ([Permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)) This static flag does **not** reflect the tenant consent policies in §2.

### 1.2 App registration and flows for a desktop tool

- A desktop app is a *public client*. Register it under **Mobile and desktop applications** with redirect `http://localhost` for system-browser sign-in. Device code flow also needs **Allow public client flows = Yes**. ([Configure desktop apps](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration))
- Device code flow uses `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode`, where `{tenant}` is `common`, `consumers`, `organizations`, or a tenant ID. The user has 15 minutes to sign in, and the client polls `/token`. A refresh token comes back only if `offline_access` was requested. ([Device code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code))
- **Device code is often blocked in work tenants.** Microsoft says: "We recommend organizations get as close as possible to a unilateral block on device code flow", using a Conditional Access *Authentication flows* condition. ([Block authentication flows](https://learn.microsoft.com/en-us/entra/identity/conditional-access/policy-block-authentication-flows)) So prefer auth code + PKCE with a loopback redirect. Only a real sign-in can show whether this tenant blocks device code.
- New registrations are single-tenant by default ("Accounts in this organizational directory only"). ([Configure desktop apps](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration)) "By default in Microsoft Entra ID, all users can register applications", but admins can switch that off (**Users can register applications = No**). The user then gets "You don't have permission to register applications in the <directoryName> directory". ([Delegate app roles](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/delegate-app-roles))

### 1.3 Token refresh

- Refresh tokens last **90 days** by default (24 h for SPA redirect URIs), and "replace themselves with a fresh token upon every use". An hourly refresh therefore keeps the session alive indefinitely. Tokens can be revoked at any time: a password change revokes password-based tokens, and an admin or the user can revoke all of them. The widget must handle this by asking the user to sign in again. ([Refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens))
- **Unverified:** Conditional Access sign-in frequency policies can force re-authentication more often. How often depends on the tenant.

## 2. Work/school tenant: is user consent gatekept?

### 2.1 Tenant consent settings

- "By default, all users are allowed to consent to applications for permissions that don't require administrator consent." Admins pick one of these settings: *Do not allow user consent*, *verified publishers + selected (low-impact) permissions* (`microsoft-user-default-low`), *Allow user consent for apps* (`microsoft-user-default-legacy`), or *Let Microsoft manage your consent settings*. ([Configure user consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent))
- `microsoft-user-default-low` allows consent "only for apps from verified publishers and apps that are registered in your tenant, and only for permissions that you classify as *low impact*". ([Configure user consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent)) Our tool has no verified publisher. A self-registered single-tenant app counts as "registered in your tenant", but `Mail.Read` still has to be classified low-impact, which an admin would have to do.

### 2.2 The Microsoft-managed policy (the likely default)

- "The setting labeled 'Let Microsoft manage your consent settings,' the Microsoft managed policy … This is also the default for a new tenant. The setting's rules are currently: End users can consent for any user consentable delegated permissions EXCEPT" a list that includes Graph `Mail.Read`, `Mail.ReadWrite`, `Mail.ReadBasic`, `MailboxItem.Read`, `MailboxFolder.Read` and more, plus Exchange Online `EAS.AccessAsUser.All`, `EWS.AccessAsUser.All`, `IMAP.AccessAsUser.All`, `POP.AccessAsUser.All`. ([Manage app consent policies](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies#microsoft-recommended-current-settings))
- Message-center post **MC1163922** set the timeline: Graph mail and calendar scopes at the end of October 2025, and IMAP/POP/EWS/EAS at the end of November 2025. It applies to "third-party apps accessing Exchange or Teams content" in tenants that use the Microsoft-managed policy. "Organizations using other user consent policies will not be affected", and users who have already consented keep their access. ([Microsoft Q&A summary](https://learn.microsoft.com/en-us/answers/questions/5572742/clarification-on-mc1163922), [MC1163922 archive](https://mc.merill.net/message/MC1163922))
- Tenants were switched to the managed setting in mid-2025 without much notice, according to an ISV report in a [Microsoft Q&A thread](https://learn.microsoft.com/en-us/answers/questions/5526830/sudden-change-to-microsoft-user-consent-settings-b). This is secondary, but consistent with the docs.
- **Unverified:** whether a single-tenant app registered **inside the same tenant** counts as "third-party". The docs list the exceptions without mentioning where the app is registered, and neither MC1163922 nor [third-party write-ups](https://blog-en.topedia.com/2025/11/microsoft-managed-default-app-consent-policy-now-blocks-20-additional-permissions/) say. Assume it is blocked until a real consent attempt shows otherwise.

### 2.3 What this means per tenant setting

| Tenant user-consent setting | Can the user self-consent `Mail.Read` for our app? |
|---|---|
| Let Microsoft manage (default for new tenants) | **No**, admin approval needed (single-tenant exemption unverified) |
| Allow user consent for apps (legacy) | **Yes** |
| Verified publishers + low-impact permissions | Only if the app is registered in the tenant **and** an admin has classified `Mail.Read` as low impact |
| Do not allow user consent | **No** |

The user can't see which setting applies without admin rights. The practical test is to try consent once and see whether the "Need admin approval" screen appears.

### 2.4 Reusing an existing public client ID

- The Microsoft-managed policy comes with a **mail client policy** (`microsoft-user-default-allow-consent-apps`), "enabled by default". It lets users consent to the mail permissions listed above for Apple Mail, Spark, eM Client, Android-Samsung, Android-Mail and **Thunderbird (`9e5f94bc-e8a4-4e73-b8be-63364c29d753`)**. ([Manage app consent policies](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies#mail-client-policy))
- Thunderbird ships that client ID in its source code with the `common` authority, the external browser, and the scopes `https://outlook.office.com/IMAP.AccessAsUser.All … offline_access`. For its Graph backend it uses the same ID with `https://graph.microsoft.com/Mail.ReadWrite …`. ([Thunderbird OAuth2Providers.sys.mjs](https://github.com/mozilla/releases-comm-central/blob/master/mailnews/base/src/OAuth2Providers.sys.mjs))
- email-oauth2-proxy says you "can also reuse the client ID and secret from any email client that supports IMAP/POP/SMTP OAuth 2.0 … but please do this with care and restraint as access through reused tokens will be associated with the token owner rather than your own client." ([email-oauth2-proxy README](https://github.com/simonrob/email-oauth2-proxy/blob/main/README.md))
- **Assessment:** a widget using Thunderbird's client ID would probably get through consent without an admin. The redirect URI must match Thunderbird's registration (**unverified** which loopback form it uses), and device code probably fails because public client flows may not be enabled on that registration (**unverified**). The costs: the tool poses as Thunderbird in the tenant's sign-in and audit logs; it bypasses a control the admin (or Microsoft for them) chose, which may break workplace IT policy; and Mozilla can change the registration at any time. It is possible, but should not be the default. At most it is an opt-in the user chooses knowingly.
- Microsoft first-party public clients such as "Microsoft Graph Command Line Tools" (`14d82eec-…`) are not a way around this. [Community reports](https://www.easy365manager.com/microsoft-graph-powershell-admin-consent/) say they also need consent for `Mail.Read` (secondary source, **unverified** under the current managed policy).

### 2.5 What exactly to ask the tenant admin

Pick one:

1. **Admin registers the app and grants consent** (least friction for the user):
   - App registration: single tenant, platform *Mobile and desktop*, redirect `http://localhost`, *Allow public client flows* = Yes (only if device code will be used).
   - API permissions: Microsoft Graph delegated `User.Read`, `Mail.Read`, `offline_access` (plus `openid`, `profile`).
   - Grant admin consent for the tenant, or **only for this user**: create an `oauth2PermissionGrant` with `consentType: "Principal"`, which needs at least Cloud Application Administrator. ([Grant consent on behalf of a single user](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-consent-single-user))
   - Send the user the **Application (client) ID** and **Directory (tenant) ID**. The widget stores them as settings.
2. **User registers the app, admin approves consent.** This needs "Users can register applications" to be on ([Delegate app roles](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/delegate-app-roles)) and the **admin consent workflow** to be enabled. The user then clicks "request approval" on the consent screen, and a reviewer approves it. ([Admin consent workflow](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-admin-consent-workflow))
3. In either case, confirm that **Conditional Access** allows the sign-in (device platform Linux, unmanaged device, and device code flow if that is used).

## 3. IMAP with OAuth2

- Basic authentication for IMAP/POP is permanently disabled in all tenants, and "no one (you or Microsoft support) can re-enable" it. OAuth 2.0 for IMAP has been available since 2020. ([Basic auth deprecation](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online))
- OAuth2 for IMAP "is available for both Microsoft 365 … and Outlook.com users". It needs an app registration, auth code or device code flow, and the scope `https://outlook.office.com/IMAP.AccessAsUser.All` (+ `offline_access`). The token is sent over SASL XOAUTH2 as `base64("user=" + user + "^Aauth=Bearer " + token + "^A^A")`, with the command `AUTHENTICATE XOAUTH2 …`. ([IMAP/POP/SMTP OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)) The server is `outlook.office365.com:993` for both Office 365 and personal accounts. ([email-oauth2-proxy sample config](https://github.com/simonrob/email-oauth2-proxy/blob/main/emailproxy.config))
- "Support for Outlook on the web and MAPI, POP3, and IMAP4 email clients is enabled by default when a user mailbox is created". Admins turn it off per mailbox with `Set-CASMailbox`. ([Managing email apps](https://learn.microsoft.com/en-us/exchange/recipients-in-exchange-online/manage-user-mailboxes/managing-email-apps-for-user-mailboxes)) Many organisations disable IMAP or block it through Conditional Access. How often that happens is **unverified**; the user would have to check.
- `IMAP.AccessAsUser.All` has needed admin consent under the managed policy since the end of November 2025 (§2.2). **IMAP has no consent advantage over Graph.** It also brings MIME parsing and XOAUTH2 plumbing that Graph avoids. The only case where IMAP wins is if the tool reuses Thunderbird's client ID (§2.4), because that registration requests IMAP scopes.

## 4. Personal Outlook.com / M365 Family (short note)

- Delegated `Mail.Read` can be consented by personal Microsoft accounts ([Permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)). The personal user consents for themselves, and no tenant admin is involved. Use authority `/consumers` (or `/common`). With personal accounts, the device code flow makes the user sign in again ([Device code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)).
- Registering the app needs *some* Entra directory. email-oauth2-proxy says a personal user can register an app if they have a Microsoft 365 Developer Programme membership or a free Azure account; otherwise they have to reuse an existing client ID ([README](https://github.com/simonrob/email-oauth2-proxy/blob/main/README.md)). The app must be registered as supporting "personal Microsoft accounts". Since the widget isn't hard-coded to one user, a shipped multi-tenant + MSA client ID would serve personal users with no setup. Whether the project wants to own such a registration (and, for work tenants, get publisher verification) is a separate decision.

## 5. What the emails contain

Main parser reference: **Home Assistant "Mail and Packages"** at release `0.6.3` (2026-09-24), [`const.py`](https://github.com/moralmunky/Home-Assistant-Mail-And-Packages/blob/0.6.3/custom_components/mail_and_packages/const.py) and [`tests/test_emails/`](https://github.com/moralmunky/Home-Assistant-Mail-And-Packages/tree/0.6.3/tests/test_emails). Its patterns come from contributors' real emails, which makes them strong evidence of what the emails look like. But they are not an official spec.

### 5.1 DHL Paket (Germany)

| Email | Sender / subject | Contents | Direction |
|---|---|---|---|
| **Paketankündigung** (parcel is coming) | `DHL Paket <noreply@dhl.de>`; genuine subject quoted as "Ihr DHL Paket kommt bald. Wann und wo möchten Sie es empfangen? Jetzt festlegen …" ([verbraucherschutz.com](https://www.verbraucherschutz.com/news/entwarnung-dhl-paketankuendigung-ihr-dhl-paket-kommt-bald-kann-echt-sein/)) | "the expected delivery time of your parcels", "an estimated delivery time window" (not everywhere), sender name if the shipper sent it. Only for registered DHL customers (Postnummer). **Not sent** for retail outlets, Packstations, small parcels, or returns. ([DHL help: Paketankündigung](https://www.dhl.de/en/privatkunden/hilfe-kundenservice/empfangen/zustellung/paketankuendigung.html)) | Incoming |
| **Delivery today** | `noreply@dhl.de`; subject `Ihre <Shop> Sendung kommt heute`; body "Sendung wird Ihnen **heute** … zugestellt" ([fixture `dhl_de_delivering.eml`](https://github.com/moralmunky/Home-Assistant-Mail-And-Packages/blob/0.6.3/tests/test_emails/dhl_de_delivering.eml)) | The **shop name (sender) is in the subject**. The tracking number is in the link query strings `custcomm.dhl.de/go/…?piececode=0034…`, not in the subject. A 90-minute time window is mentioned by secondary sources (**unverified**). | Incoming |
| **Delivered** | `noreply@dhl.de` / `no-reply@dhl.de`; HA subject patterns: `wurde zugestellt`, `Sendung zugestellt`, `Paket wurde zugestellt`, `Zustellung an Ablageort`, `liegt am gewünschten Ablageort`, `Sendung liegt im Briefkasten` ([const.py `dhl_delivered`](https://github.com/moralmunky/Home-Assistant-Mail-And-Packages/blob/0.6.3/custom_components/mail_and_packages/const.py)) | Terminal Status Delivered | Incoming |
| **Ready for pickup** (Packstation/Filiale) | Not covered by HA and not described in DHL's public help. **Unverified** whether an email exists at all (the app push may be the only channel). | — | Incoming |
| **Paketmarke purchase confirmation** (DHL Online Frankierung) | Sender **unverified** | "Versandmarke herunterladen" (PDF label) button and a QR code to print the label at a Packstation or branch ([paketda.de](https://www.paketda.de/frankieren/dhl.html), secondary). Whether the **tracking number appears in the email text** is **unverified**. It's probably inside the PDF. | **Outgoing** |
| **"Sendungsbenachrichtigung"** (notification about a Shipment the user sent) | No public description found. **Unverified.** | — | Outgoing |

- Genuine DHL senders are "ausschließlich paket@dhl.de oder noreply@dhl.de" ([Händlerbund quoting DHL](https://ohn.haendlerbund.de/logistik/paketdienste/verunsicherung-dhl-sicherheitswarnung); [Deutsche Post security notes](https://www.deutschepost.de/de/w/warnung-vor-gefaelschten-mails.html) confirm `noreply@dhl.de`). Genuine link hosts are `nolp.dhl.de`, `mailing.dhl.de` ([Deutsche Post](https://www.deutschepost.de/de/w/warnung-vor-gefaelschten-mails.html)), and `custcomm.dhl.de` (fixture). **Filtering on the sender address is the anti-phishing guard**, because DHL-themed phishing is very common.
- Tracking number regex used by HA: `JJD\d{18}|JVGL\d{20}|MDP[A-Z0-9]{5,15}|00\d{18}|(?<![0-9])\d{10,11}(?![0-9])` ([const.py `dhl_tracking`](https://github.com/moralmunky/Home-Assistant-Mail-And-Packages/blob/0.6.3/custom_components/mail_and_packages/const.py)). DHL Paket numbers are commonly **12-digit**, **20-digit (`0034…`)**, or **`JJD…`**, each with a check digit ([paketda.de Prüfziffern](https://www.paketda.de/firmenkunden/paket-pruefziffern.html), secondary). HA's regex doesn't cover 12-digit numbers, so we need our own. The safest extraction is the `piececode=` query parameter.

### 5.2 amazon.de

| Email | Sender / subject (German) | Contents | Direction |
|---|---|---|---|
| Order confirmation | `bestellbestaetigung@amazon.de` ([Telekom community](https://telekomhilft.telekom.de/conversations/e-mail/probleme-mit-mails-von-absender-bestellbestaetigungamazonde/66861b004ae73561da8b2568)) | Order ID | Incoming |
| **Shipped** | `versandbestaetigung@amazon.de` (HA `AMAZON_EMAIL`, [Telekom community](https://telekomhilft.telekom.de/conversations/e-mail/probleme-mit-mails-von-absender-bestellbestaetigungamazonde/66861b004ae73561da8b2568)); HA also searches `shipment-tracking@`, `order-update@`, `auto-confirm@` on every Amazon domain. Subject `Versandt:` / `Versendet:` | Order ID; estimate after `Zustellung:` or `Ankunft` (HA `AMAZON_TIME_PATTERN(_REGEX)`), up to a `Lieferung verfolgen` / `Ihr Paket verfolgen` / `Verfolge deine(n) Artikel` link | Incoming |
| **Out for delivery** | Subject `In Zustellung:` | "Arriving today"-style estimate | Incoming |
| **Delivered** | Subject `Zugestellt:` / `Geliefert:` | Terminal Status Delivered | Incoming |
| **Delayed** | HA only knows English: subject `Delivery update:`, body `running late` ([fixture `amazon_exception.eml`](https://github.com/moralmunky/Home-Assistant-Mail-And-Packages/blob/0.6.3/tests/test_emails/amazon_exception.eml): "running late … Now expected March 27 - March 28"). The German wording is **unverified**. | New estimate range | Incoming |
| Amazon Hub / locker pickup | HA includes `versandbestaetigung@amazon.de` in `AMAZON_HUB_EMAIL`, but its subject/body patterns are English only (`ready for pickup from Amazon Hub Locker`, 6-digit pickup code). German wording **unverified**. | Pickup code → Ready for pickup | Incoming |

(Subject and sender patterns above come from [const.py @ 0.6.3](https://github.com/moralmunky/Home-Assistant-Mail-And-Packages/blob/0.6.3/custom_components/mail_and_packages/const.py).)

- **Order ID**: `[0-9]{3}-[0-9]{7}-[0-9]{7}`, found in the subject or body (HA `AMAZON_PATTERN`). This lines up with the **Order** term in CONTEXT.md.
- **Shipment identity:** recent templates link to `…/progress-tracker/package?…orderId=…&shipmentId=…&packageIndex=0` or `…/shiptrack/view.html?orderID=…&orderingShipmentId=…&packageId=1` (fixtures [`amazon_uk_delivered.eml`](https://github.com/moralmunky/Home-Assistant-Mail-And-Packages/blob/0.6.3/tests/test_emails/amazon_uk_delivered.eml), [`amazon_shipped_details.eml`](https://github.com/moralmunky/Home-Assistant-Mail-And-Packages/blob/0.6.3/tests/test_emails/amazon_shipped_details.eml)). `shipmentId`/`packageIndex` let us split one Order into several Shipments.
- **Carrier and tracking number:** an older amazon.co.uk dispatch template said "being sent by Amazon Logistics. Your tracking number is QA0881872248" ([fixture `amazon_uk_shipped.eml`](https://github.com/moralmunky/Home-Assistant-Mail-And-Packages/blob/0.6.3/tests/test_emails/amazon_uk_shipped.eml)). The newer templates in the fixtures (amazon.com/.ca, "Your package was shipped!") show only the Order ID, estimate and progress-tracker link, with **no Carrier and no carrier tracking number**. **Unverified for amazon.de.** If that holds, emails alone can't match an Amazon Shipment to its DHL tracking (the dedupe problem on the map). The Amazon order page, or a DHL email that names Amazon as the sender, would have to link them.
- Amazon's own help pages (amazon.de/.com "Track your package") returned HTTP 503 to automated fetches, so we couldn't cite them.

### 5.3 Direction from email

- Every DHL notification email and every amazon.de email is **Incoming**. The DHL subject even names the sending shop.
- **Outgoing** DHL Shipments are only seen through label-purchase confirmations, which only exist if the user bought the label online. Whether they carry a text tracking number is **unverified**. Outgoing Status updates by email were not found in public docs. So Outgoing tracking needs the tracking API ([#2 findings](https://github.com/kreuzhofer/omarchy-shipment-tracker/blob/research/dhl-official-apis/docs/research/dhl-official-apis.md)) once the number is known, or manual add.

## Unverified / open

- Whether the Microsoft-managed consent policy also blocks **single-tenant apps registered in the same tenant** (§2.2).
- This tenant's actual consent setting, whether app registration is allowed, whether IMAP is on, and its Conditional Access rules (only the user or admin can check).
- Thunderbird client ID redirect URI and whether it allows device code (§2.4).
- German amazon.de templates: whether the Carrier or tracking number is present, and the wording of delayed and pickup emails.
- DHL Ready for pickup email, "Sendungsbenachrichtigung", and the contents and sender of Paketmarke confirmations.
