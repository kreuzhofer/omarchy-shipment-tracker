# M365 work tenant access: how Softeria's ms-365-mcp-server gets in, and which route we use

Research for [#15](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/15). Follows up [m365-mail-discovery.md](https://github.com/kreuzhofer/omarchy-shipment-tracker/blob/research/m365-mail-discovery/docs/research/m365-mail-discovery.md) (#5). Sources checked 2026-09-29. Nothing was logged in to or installed. Softeria source is cited at commit [`e2d4aa5`](https://github.com/Softeria/ms-365-mcp-server/tree/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7) (v0.156.2, the latest on npm).

Source links point at that commit.

## Answer

- **How Softeria authenticates.** It is a plain MSAL Node public client. By default it uses **Softeria's own multi-tenant app registration**, client ID `084a3e9f-a9f4-43f7-89f9-d229cf97853e`, which shows up in tenants as the enterprise app **"MS 365 MCP Server"**. It is not a Microsoft first-party ID. The authority is `https://login.microsoftonline.com/common`. The default sign-in is device code flow, with an optional browser/loopback flow. Scopes come from the enabled tools. The mail tools need delegated `Mail.Read` (plus `Mail.ReadWrite`/`Mail.Send` unless the server runs `--read-only`). MSAL always adds `openid profile offline_access`. The token cache is an AES-256-GCM encrypted file in `~/.config/ms-365-mcp-server/.token-cache.json`, with its key in the OS keyring.
- **The "~30 days" is not a Microsoft limit.** Entra refresh tokens last 90 days, renew on every use, and refresh-token lifetime can't be configured. What ends a session earlier is either a tenant Conditional Access *sign-in frequency* policy, or Softeria losing its cache. Until August 2026 the cache lived **inside the npx package directory**, and Softeria ships several releases a week, so an `npx -y` upgrade wiped it. There was also a separate cache bug (#648).
- **Why it works on the work tenant.** Under Microsoft's documented defaults it should not: the Microsoft-managed consent policy blocks user consent to `Mail.Read` for every app except six allow-listed mail clients, and "MS 365 MCP Server" is not one of them. So one of these must be true for this tenant: **(1)** someone already granted consent that still applies (the user consented before the late-October 2025 change, which grandfathers existing grants, or an admin granted tenant-wide consent because colleagues use it); **(2)** the tenant is on the legacy "Allow user consent for apps" setting and never switched to the Microsoft-managed one; or **(3)** the user holds an admin role that can consent. Only the tenant can tell which one it is (§2.4).
- **Route (delegated): use (b). The widget talks to a pinned, locally installed copy of Softeria's server over MCP stdio, as a read-only mail connector.** Run it as `--preset mail --read-only`, or narrower as `--enabled-tools '^(list-mail-messages|get-mail-message)$'`. It gets its own token-cache path and a pinned account. The app identity in the tenant is then truthfully "MS 365 MCP Server", because that is the code running. It reuses a consent that already works, so no admin step is needed today.
  - **(a) Our own app registration is the fallback**, and only with admin approval. It is unverified, so a multi-tenant app runs into risk-based step-up. Under the managed policy, `Mail.Read` is blocked for us anyway.
  - **(c) Reusing Softeria's client ID inside our own code is rejected.** It would misrepresent our code to the tenant and exploit a grant that was given to someone else's software.
- **For the Amazon spike:** mail can be included, through route (b), as a *best-effort* discovery input. The Amazon spike must still work without mail.

---

## 1. How Softeria authenticates (source)

### 1.1 Client ID, authority, flows

| What | Value | Source |
|---|---|---|
| Default client ID (global cloud) | `084a3e9f-a9f4-43f7-89f9-d229cf97853e`, "pre-registered public client applications" | [`src/cloud-config.ts` L45-52](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/cloud-config.ts#L45-L52) |
| Override | `MS365_MCP_CLIENT_ID` (else the default), `MS365_MCP_TENANT_ID` (else `common`) | [`src/secrets.ts` L35-36](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/secrets.ts#L35-L36) |
| MSAL config | `PublicClientApplication` with `authority: https://login.microsoftonline.com/${tenantId \|\| 'common'}` | [`src/auth.ts` L54-62](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/auth.ts#L54-L62), [L1-2](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/auth.ts#L1-L2) |
| Device code flow (default) | `msalApp.acquireTokenByDeviceCode({ scopes, deviceCodeCallback })` | [`src/auth.ts` L1284-1303](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/auth.ts#L1284-L1303); README ["Device Code Flow (Default)"](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/README.md#L383-L398) |
| Browser flow (opt-in) | `--auth-browser` → `acquireTokenInteractive` with a localhost callback | [`src/cli.ts` L100-101](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/cli.ts#L100-L101), [`src/auth.ts` L1334-1357](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/auth.ts#L1334-L1357), [`src/index.ts` L96-110](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/index.ts#L96-L110) |
| Silent refresh | `acquireTokenSilent({ account, scopes })` on every Graph call that needs a new token | [`src/auth.ts` L1208-1233](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/auth.ts#L1208-L1233) |


**Whose app it is.** The ID has been hard-coded since the project's first commit (`c620d34`, 2025-04-02). It is **not** in the community list of Microsoft first-party app IDs ([merill/microsoft-info `MicrosoftApps.csv`](https://github.com/merill/microsoft-info/blob/main/_info/MicrosoftApps.csv); that list does contain e.g. Microsoft Graph Command Line Tools `14d82eec-…`). The maintainer calls it "the shared Softeria app" whose permissions he keeps "as lean as possible" ([issue #505](https://github.com/Softeria/ms-365-mcp-server/issues/505)). Admins find it in Entra as the enterprise app "MS 365 MCP Server" and can grant tenant-wide consent there ([issue #134](https://github.com/Softeria/ms-365-mcp-server/issues/134)). So it is **Softeria's own multi-tenant registration** (it has to be multi-tenant, since it is used with `/common` across unrelated tenants). **Unverified:** whether it carries a Microsoft *verified publisher* badge. The repo does not say. The user can see this on the consent screen or in the tenant's Enterprise apps.

### 1.2 Scopes

- Every tool in [`src/endpoints.json`](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/endpoints.json) declares its Graph scopes. At startup the server requests the union of the scopes for the enabled tools, and collapses `Read` into `ReadWrite` when both are present ([`src/auth.ts` `buildScopesFromEndpoints` L437-486](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/auth.ts#L437-L486)).
- The mail read tools: `list-mail-messages` (`GET /me/messages`, scope `Mail.Read`, presets `mail, outlook, personal`) and `get-mail-message` (`GET /me/messages/{id}`, `Mail.Read`) ([`endpoints.json` L9-17, L73-79](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/endpoints.json#L9-L17)).
- With no flags, the personal (non-org) tool set requests `Calendars.ReadWrite Contacts.ReadWrite Files.ReadWrite Mail.ReadWrite Mail.Send MailboxSettings.ReadWrite Notes.* Sites.Selected Tasks.ReadWrite User.ReadWrite` and more (computed from `endpoints.json`). `--preset mail` narrows this to `Mail.*`, `MailboxSettings.*` and `User.Read`, and `--read-only` drops the write tools. `--org-mode` adds work-only scopes such as Teams and SharePoint (README §"Organization Account Tools").
- MSAL adds the OIDC defaults `openid`, `profile` and `offline_access` to every request ([msal-common `Constants.ts` `OIDC_DEFAULT_SCOPES`](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-common/src/utils/Constants.ts#L75-L79)). `offline_access` is what makes Entra issue a refresh token. It is also "implicitly granted" whenever any delegated permission is granted ([OIDC scopes](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc)).

### 1.3 Token cache

- The path is `$XDG_CONFIG_HOME/ms-365-mcp-server/.token-cache.json` (or `~/.config/…`), overridable with `MS365_MCP_TOKEN_CACHE_PATH`. The selected account is kept in `.selected-account.json` ([`src/lib/config-paths.ts` L4-28](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/lib/config-paths.ts#L4-L28), [`src/token-cache-storage.ts` L49-51, L178-186](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/token-cache-storage.ts#L178-L186)).
- The cache files are AES-256-GCM ciphertext. The 32-byte key goes in the OS credential store via `keytar` (service `ms-365-mcp-server`), with a file fallback ([PR #624](https://github.com/Softeria/ms-365-mcp-server/pull/624), [`token-cache-storage.ts` L38](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/token-cache-storage.ts#L38)). A cache plugin reloads the cache before every write, so several stdio processes can share one cache safely ([issue #545](https://github.com/Softeria/ms-365-mcp-server/issues/545), [`auth.ts` L227-260](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/auth.ts#L227-L260)).
- **Before PR #624 (merged 2026-08-10)** the cache "defaulted to a path inside the installed package, so under npx it resolved to …`_npx\<hash>\node_modules\…`. … `npm cache clean` or a version bump discarded it". Even after the fix, "an npx version bump still costs one sign-in" once ([PR #624 description](https://github.com/Softeria/ms-365-mcp-server/pull/624)).

### 1.4 Why the user saw "about 30 days"

Microsoft's side:

- Refresh tokens: "90 days for all other scenarios" (24 h only for SPAs), and they "replace themselves with a fresh token upon every use" ([Refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)). The default sign-in frequency is "a rolling window of 90 days" ([Session lifetime](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-session-lifetime)).
- "As of January 30, 2021, refresh and session token lifetimes are no longer configurable … To control how frequently users are required to sign in, use Conditional Access sign-in frequency instead." ([Configurable token lifetimes](https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes))

So a sliding session that is used regularly should stay valid until it is revoked. A cut after about 30 days points to one of these:

1. **Softeria lost its cache.** Before 2026-08-10 the cache lived in the npx package directory. The typical `npx -y @softeria/ms-365-mcp-server` setup pulls new versions, and Softeria released 18 to 55 versions per month in 2026 (from the repo's tags). A version bump means a new device-code login. This fits "roughly 30 days" for ordinary use.
2. **Tenant Conditional Access sign-in frequency**, e.g. 30 days. This is common in managed tenants but specific to each tenant (**unverified** for this tenant).
3. **Softeria bug [#648](https://github.com/Softeria/ms-365-mcp-server/issues/648)** (v0.146, fixed since): the cache kept replaying the original refresh token until it hit the 90-day wall.

For our widget, the design has to assume re-login can be needed at any time. The expected good case is "sign in once, stays signed in for months".

## 2. Why it can work on a work tenant

### 2.1 The documented defaults say it should be blocked

- **Microsoft-managed policy** ("Let Microsoft manage your consent settings", "the default for a new tenant"): "End users can consent for any user consentable delegated permissions EXCEPT" Graph `Mail.Read`, `Mail.ReadWrite`, `Mail.ReadBasic`, `MailBoxSettings.*`, `Calendars.*`, `Contacts.ReadWrite`, `Tasks.*`, `Files.Read(Write).All`, … ([Manage app consent policies](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies#microsoft-recommended-current-settings)). The exception list is based on the permission, not the publisher, so verification does not help.
- The **mail client policy** exempts only Apple Mail, Spark, eM Client, Android-Samsung, Android-Mail and Thunderbird (same page). "MS 365 MCP Server" is not among them.
- **Risk-based step-up consent** is on by default: "consent requests for newly registered multitenant apps that aren't publisher verified and require nonbasic permissions are considered risky … the request requires a 'step-up' to admin consent" ([Risk-based step-up consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-risk-based-step-up-consent)). It applies to "apps that were registered after November 8, 2020 … which request consent from users in tenants that aren't the tenant where the app is registered" ([Publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)). It "results in a behavior change only when user consent is enabled".
- Delegated `Mail.Read` itself is *AdminConsentRequired: No* in the permissions reference ([Permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference#mailread)). So it *is* user-consentable, except where a tenant policy says otherwise. Since late 2025, the managed policy says otherwise.

### 2.2 Why it still works: existing grants, legacy setting, or admin

- **Existing grants survive.** Consent is checked at sign-in: "If no previous record of user or admin consent for the required permissions exists, the user is directed to the consent prompt". Even with user consent disabled, "Users continue to sign in to applications they already consented to or to applications that administrators grant consent to on their behalf" ([User and admin consent overview](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/user-admin-consent-overview)). Microsoft's summary of MC1163922 says the same for the late-2025 change: users who already consented keep their access ([Q&A on MC1163922](https://learn.microsoft.com/en-us/answers/questions/5572742/clarification-on-mc1163922)). Softeria's client ID dates from April 2025, so a consent given before the end of October 2025 still holds.
- **Admin grant.** A tenant admin can grant tenant-wide consent to "MS 365 MCP Server" from Enterprise apps ([issue #134](https://github.com/Softeria/ms-365-mcp-server/issues/134)). After that, every user just signs in with no prompt, and the admin step would be invisible to this user.
- **Legacy setting.** "Organizations using other user consent policies will not be affected" by MC1163922 ([Q&A](https://learn.microsoft.com/en-us/answers/questions/5572742/clarification-on-mc1163922)). A tenant still on `microsoft-user-default-legacy` ("Allow user consent for apps") lets users consent to any user-consentable permission ([Configure user consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent)). Only risk-based step-up could still stop it, if the app is unverified.
- **User is an admin.** "An application admin can consent to everything a regular user can … and they also have" admin consent rights ([Manage app consent policies](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies)). If the user holds Global/Cloud Application/Application Administrator in the tenant, no approval was needed.

### 2.3 What that means for us

Whichever of these applies, the grant or policy belongs to **the app "MS 365 MCP Server"**, not to "any app that reads mail". A brand-new app of ours meets the tenant's *current* policy from scratch. Under the managed policy, or with step-up for an unverified multi-tenant app, that means admin approval.

### 2.4 How to find out which case applies (for the user, optional)

- The Enterprise app "MS 365 MCP Server" → Permissions tab shows "Admin consent" vs "User consent" grants. This needs an admin or directory reader (Entra admin center; same place as in [issue #134](https://github.com/Softeria/ms-365-mcp-server/issues/134)).
- Without admin rights: the end-user **My Apps** portal (`myapps.microsoft.com`) lists apps the user has consented to. **Unverified** whether it tells user grants apart from admin grants in this tenant.
- None of this is needed to proceed with route (b).

## 3. Route options

### (a) Our own app registration

- **Multi-tenant, unverified, shipped client ID.** Under the managed policy, `Mail.Read` is blocked for user consent no matter who publishes the app (§2.1). Under the legacy policy it is "newly registered", multi-tenant and unverified with a non-basic permission, which is the textbook risk-based step-up case → admin consent. Publisher verification needs a Microsoft AI Cloud Partner Program account tied to a domain ([Publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)), which is too much overhead for a personal widget, and it would still not beat the managed policy.
- **Single-tenant, registered by the user in the work tenant.** This avoids step-up, which only applies to tenants other than the registering one. But the managed policy still blocks `Mail.Read` (single-tenant exemption unverified, see #5 §2.2), and "Users can register applications" may be off.
- **Verdict:** clean and honest, but needs an admin in this tenant. Keep it as the **fallback** and use the admin request already written in [#5 §2.5](https://github.com/kreuzhofer/omarchy-shipment-tracker/blob/research/m365-mail-discovery/docs/research/m365-mail-discovery.md#25-what-exactly-to-ask-the-tenant-admin). It is also the natural route for personal Outlook.com accounts, which have no admin in the way.

### (b) Softeria's server as a dependency (chosen)

- **Honesty.** The token is issued to "MS 365 MCP Server", and the code that holds it and calls Graph *is* Softeria's MCP server, unmodified, run by the user. Our widget is an MCP client of it, exactly like Claude Code is. The tenant's audit log truthfully shows that app, and any admin or user grant is used for the software it was given to.
- **Interface.** There is no one-shot "call a tool from the shell" flag. The CLI has `--login`, `--verify-login`, `--list-accounts`, `--logout` and server flags ([`src/cli.ts` L19-120](https://github.com/Softeria/ms-365-mcp-server/blob/e2d4aa5e21babec1edd326b30eeb6d03b6808fe7/src/cli.ts#L19-L120)). So the widget backend spawns the server over stdio and speaks MCP JSON-RPC (`initialize`, then `tools/call` `list-mail-messages` with `$search="from:noreply@dhl.de OR from:versandbestaetigung@amazon.de"` and `$select`, then `get-mail-message` for bodies).
- **Least privilege.** Run it with `--read-only --enabled-tools '^(list-mail-messages|get-mail-message)$'`. It then requests only `Mail.Read` (+ `User.Read` and the OIDC defaults), a subset of what the existing grant covers, so no new consent prompt should appear (**unverified until tried**). README §"allowed scopes" also documents `--allowed-scopes` for pinning.
- **Isolation.** Set `MS365_MCP_TOKEN_CACHE_PATH`/`MS365_MCP_SELECTED_ACCOUNT_PATH` to the widget's own state dir and pin the account with `MS365_MCP_EXPECTED_USERNAME` (README §"Multi-account"). This way the widget does not share the user's Claude MCP cache and can't pick the wrong account. It costs one device-code login (`--login`) at setup. The consent already exists, so that login is only a sign-in.
- **Install.** Install it pinned, locally in the widget's own directory (`npm install --prefix … @softeria/ms-365-mcp-server@<exact>`), not `npx -y` latest. The project ships several releases a week and has had security advisories (e.g. GHSA-9w34-3f56-vwmh, referenced in PR #624). A pinned version also avoids the cache-reset behaviour from §1.4.
- **Costs and risks.** It adds a Node runtime dependency. The widget depends on Softeria keeping its registration, and on the tenant not revoking or blocking it. The widget has to handle "needs sign-in" (surface a re-login action that runs `--login` and shows the device code). Device code flow works in this tenant today (the user did it), but Microsoft recommends tenants block it ([Block authentication flows](https://learn.microsoft.com/en-us/entra/identity/conditional-access/policy-block-authentication-flows)); `--auth-browser` is the escape hatch (whether Softeria's registration allows the loopback redirect is **unverified**).
- **Workplace policy.** This reads a *work* mailbox for private Shipments. The tenant permits this app, but whether the employer is fine with that use is the user's call, and it is outside what this research can settle.

### (c) Reusing Softeria's client ID in our own code (rejected)

- Our own code would present itself to the tenant as "MS 365 MCP Server". The sign-in and audit logs would misattribute our traffic, and any consent (especially an admin's tenant-wide grant, or a user grant from before the policy change) would be used for software it wasn't given to. That bypasses the tenant's current consent control in the same way as reusing Thunderbird's ID ([#5 §2.4](https://github.com/kreuzhofer/omarchy-shipment-tracker/blob/research/m365-mail-discovery/docs/research/m365-mail-discovery.md#24-reusing-an-existing-public-client-id)), and email-oauth2-proxy explicitly warns about it ("access through reused tokens will be associated with the token owner rather than your own client", [README](https://github.com/simonrob/email-oauth2-proxy/blob/main/README.md)).
- It also buys nothing technical over (b): the same registration, redirect URIs and grant, but without Softeria's cache handling.
- **Rejected.**

## 4. Decision (delegated)

**(delegated)** Mail discovery on the work tenant goes through **route (b)**: a pinned, locally installed `@softeria/ms-365-mcp-server`, spawned over MCP stdio as a read-only connector limited to `list-mail-messages` and `get-mail-message`, with its own token cache and pinned account. We do **not** reuse Softeria's client ID in our own code (c). Our own app registration (a) is the fallback, and it needs admin approval (the #5 §2.5 request) if the Softeria grant ever disappears or the tenant blocks it. Mail stays a best-effort discovery input. The widget must work without it.

## Unverified / open

- Which of §2.2's explanations applies in this tenant (pre-change user grant, admin grant, legacy setting, or admin role).
- Whether Softeria's app is publisher-verified.
- Whether a narrower scope request (`Mail.Read` only) signs in silently against the existing grant without any new prompt. Expected yes, but only a real `--login` shows it.
- Whether this tenant has a sign-in-frequency policy (would explain ~30 days independently of Softeria's cache).
- Whether Softeria's registration permits the `--auth-browser` loopback redirect.
