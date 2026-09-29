# Low-detection browser automation for amazon.de

Research for [#16](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/16), part of map [#1](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/1). Builds on [#6 Background browser automation](https://github.com/kreuzhofer/omarchy-shipment-tracker/blob/research/background-browser-automation/docs/research/background-browser-automation.md) and [#4 amazon.de Orders and Shipments](https://github.com/kreuzhofer/omarchy-shipment-tracker/blob/research/amazon-orders/docs/research/amazon-orders.md). The user accepted the Conditions-of-Use risk for their own account in [#14](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/14).

Question: which automation approach makes hourly reads of the user's own amazon.de order history and tracker pages least distinguishable from a real user? What risk remains for the account?

Researched 2026-09-29 against Google Chrome 154.0.8037.57 and Hyprland 0.56.2 (both installed locally). Sources are project repos, package registries, Chromium source, CDP and Chrome docs, and AWS WAF docs. Nothing was installed and amazon.de was not visited.

## Answer

- **Decision (delegated): the Amazon spike drives the installed Google Chrome itself.** Our helper launches `google-chrome-stable` with a dedicated persistent profile. It runs **headful** on a silent Hyprland special workspace, not headless. It opens a **fixed** `--remote-debugging-port` on 127.0.0.1 and adds no automation flags. The helper attaches to the port with a **minimal CDP client** that never calls `Runtime.enable` and never runs script in the page's main world. It navigates, waits for load, reads the HTML (`DOM.getOuterHTML`) and parses it in Node. Chrome is closed cleanly after each run.
- **Why this beats the stealth frameworks:** every leak those frameworks patch comes from a launcher or library we would not be using.
  - `navigator.webdriver` is set by `--enable-automation`, `--headless`, `--remote-debugging-pipe` and `--remote-debugging-port=0`. A fixed port does not set it [C1].
  - The "HeadlessChrome" user agent comes only from headless mode [C2].
  - The `Runtime.enable` leak needs `Runtime.enable` [R1].
  - The default viewport, `__pwInitScripts` and `--disable-field-trial-config` come from Playwright [R2][P3].
  - TLS and HTTP/2 fingerprints are Chrome's own by construction, because the browser *is* the user's everyday Chrome build.
- **If CDP by hand proves too laborious, use Patchright** (`patchright` 1.63.0, 2026-09-08, tracks Playwright 1.63) with `launchPersistentContext(dir, { channel: "chrome", headless: false, viewport: null })`, which is its documented "best practice" [P1][P2]. Reject the others:
  - playwright-extra + stealth: last release March 2023, detectable JS overrides.
  - rebrowser-patches: last tested against Playwright 1.52, May 2025.
  - Camoufox: Firefox, beta, rotates its fingerprint per launch by default.
  - undetected-chromedriver: last release Feb 2024.
  - nodriver: Python. It defaults to `--remote-allow-origins=*` and `--password-store=basic` and disables site isolation.
- **Challenges are never solved by the helper.** Any sign-in, OTP, CVF, captcha, WAF or "not a robot" page stops the run at once. It writes `needs-login` and pauses Amazon polling until the user acts. The user then solves the challenge in **the same Chrome window**, which the widget brings to the current workspace. No captcha solvers, no stored password, no stored TOTP secret.
- **Pacing:** fire at most hourly, with systemd `RandomizedDelaySec=15min` [L2]. Load one order-history page plus tracker pages only for Shipments whose Status is not terminal, capped at 6 pages per run. Wait 4–12 s at random between pages, reach tracker pages by following their links from the history page, add night-time quiet hours, and set a daily cap of about 80 pages. Stay on one network; no proxies or VPN hopping.
- **Residual risk:** Amazon's bot defence is not publicly documented. The login flow does use AWS WAF challenges [A1]. AWS WAF Bot Control *can* score automation signals, browser inconsistencies, per-session request volume and token reuse across IPs/ASNs [W1][W2]. The setup above removes the known automation signals, but behaviour-based ML scoring cannot be ruled out. The main remaining risks are forced re-login/OTP and captcha, not account locks (unverified). Keep 1-Click ordering off [A2].

### Spike setup

- npm: `chrome-remote-interface` (CDP client) and `cheerio` (HTML parsing). Fallback: `patchright` with the Patchright options above.
- Launch (the helper spawns it detached and polls `http://127.0.0.1:9333/json/version` until ready):

  ```
  google-chrome-stable \
    --user-data-dir=$HOME/.local/share/omarchy-shipment-tracker/chrome-profile \
    --remote-debugging-port=9333 \
    --password-store=gnome-libsecret \
    --class=ShipmentTrackerChrome \
    --no-first-run --no-default-browser-check \
    about:blank
  ```

  Do **not** add `--headless`, `--enable-automation`, `--remote-debugging-pipe`, port `0`, `--remote-allow-origins`, `--user-agent`, `--disable-blink-features=…` or any Playwright default. Pick any fixed port other than 9222 (the widely known default).
- Hyprland rule: `o.window("^ShipmentTrackerChrome$", { workspace = "special:shiptracker silent" })`.
- CDP calls used: `Target.createTarget`/attach, `Page.enable`, `Page.navigate`, wait for `Page.loadEventFired`, `DOM.getDocument` + `DOM.getOuterHTML`, and `Browser.close`. Never use `Runtime.enable`, `Page.addScriptToEvaluateOnNewDocument`, `Emulation.*` or `Network.setUserAgentOverride`.
- First run: the same command without the hidden-workspace rule (or with the window moved to the current workspace). The user signs in with "Angemeldet bleiben" and turns off 1-Click.

## Comparison

| | **Real Chrome, own launch + raw CDP (recommended)** | Patchright (`channel: "chrome"`) | playwright-extra + stealth | rebrowser-patches | Camoufox | nodriver / undetected-chromedriver |
|---|---|---|---|---|---|---|
| `navigator.webdriver` | false: no `--enable-automation`/`--headless`/pipe/port 0 [C1] | false: adds `--disable-blink-features=AutomationControlled`, drops `--enable-automation` [P1] | overridden in JS (`navigator.webdriver` evasion) [S2] | not patched; needs the flag by hand [R2] | patched in Firefox C++ [F1] | nodriver: no automation flag, fixed port [N1]; uc: patched chromedriver [N2] |
| `Runtime.enable` / CDP leak | not called by design [D1] | removed; JS runs in isolated contexts [P1][P4] | not addressed | fixed (`addBinding` / `alwaysIsolated`) [R1] | n/a (Juggler, not CDP); main-world execution sandboxed [F1] | nodriver core never calls `runtime.enable` [N1] |
| Other launcher tells | none: the flag set is ours | keeps other Playwright defaults, e.g. `--disable-field-trial-config`, `--disable-background-networking` [P3][P4] | Playwright defaults + JS patches that can contradict each other (open issue #940: WebGL spoof vs `navigator.gpu`) [S3] | Playwright defaults | fingerprint spoofing; random OS by default [F2] | nodriver: `--remote-allow-origins=*`, `--password-store=basic`, `--disable-features=IsolateOrigins,site-per-process` [N1] |
| Headless tell | not headless | headful recommended [P2] | `HeadlessChrome` UA unless headful | same | own headless / Xvfb [F2] | nodriver strips "Headless" from UA via override in headless [N1] |
| TLS / HTTP2 fingerprint | the installed Chrome's own | same (real Chrome binary) | bundled Chromium unless `channel: "chrome"` | same | real Firefox (NSS); UA claims Firefox, so consistent | the installed Chrome |
| Maintenance (2026-09-29) | Chrome auto-updates via pacman; `chrome-remote-interface` 0.34.0 (2026-02) [M1] | active: npm 1.63.0 2026-09-08; driver repo pushed 2026-09-13 [M1][M2] | stale: 4.3.6 / 2.11.2, 2023-03 [M1] | stale: 1.0.19, 2025-05; tested to Playwright 1.52 [M1][R1] | active but beta: v156.0.1-beta.32 2026-09-28; README: "may not be suitable for stable production use" [M2][F1] | nodriver 0.50.3 2026-05; uc 3.5.5 2024-02 [M1]; active fork zendriver 0.17.0 2026-09 |
| Language | Node | Node (also Python) | Node | Node | Python/JS | Python |
| Linux/Wayland | native Wayland Chrome; hide on special workspace | same | same | same | Firefox; `headless="virtual"` uses Xvfb [F2] | same as Chrome |
| Persistent profile / device trust | yes, one stable profile | `launchPersistentContext` | yes | yes | `persistent_context` + fixed `fingerprint_preset`, else a new "device" each launch [F2] | nodriver: "fresh profile on each run" by default [N1] |
| Captcha stance | stop and surface | stop and surface | recaptcha plugin exists (do not use) | – | – | nodriver ships `cf_verify()` auto-clicker (do not use) [N1] |

## Details

### 1. Where automation leaks come from (Chromium primary sources)

- **`navigator.webdriver`.** Chromium enables `AutomationControlled` for `--enable-automation`, `--headless` and `--remote-debugging-pipe`, and for `--remote-debugging-port=0`. A *specific* port number is left alone because "this is more likely for attaching a debugger… ensure the browser behaves as it does when not under automation control" [C1]. So a Chrome we start ourselves with `--remote-debugging-port=9333` reports `navigator.webdriver === false` without any flag hacks. Playwright and Patchright launch over a pipe [P3], which is why Patchright needs `--disable-blink-features=AutomationControlled` [P1].
- **Headless UA.** `GetUserAgentInternal()` prepends "Headless" to the product when `--headless` is present, giving `HeadlessChrome/…` [C2]. The client-hint brand list comes from the product name and is not changed [C2]. Headless Chrome therefore sends a UA that disagrees with its own `Sec-CH-UA`, unless you override the UA, which is itself a consistency risk. New headless is otherwise the real browser [C3][P5]. Headful avoids the whole class of problems. AWS WAF has an explicit "browser inconsistency" rule [W1].
- **`Runtime.enable`.** This CDP method "enables reporting of execution contexts creation" [D1]. Puppeteer, Playwright and Selenium all call it, and pages could detect it through console-serialization side effects [R1][R3]. Two V8 commits in May 2025 (M137) stopped the classic Error-stack-getter probe. Researchers report that other variants still work in some setups [R4] (secondary). Not calling it at all is the only robust answer. A client can evaluate script without it by creating its own world (`Page.createIsolatedWorld`) [D1], or skip page JS entirely and read `DOM.getOuterHTML`.
- **Playwright defaults.** Playwright launches Chromium with `--disable-field-trial-config`, `--disable-background-networking`, `--disable-extensions`, `--disable-component-update`, a `--disable-features=` list and more [P3]. It also sets a 1280×720 viewport and injects `__pwInitScripts` [R2]. Patchright removes some of these (e.g. `--enable-automation`, `--disable-extensions`, `--disable-component-update`) but keeps the rest, including the field-trial one [P4]. Whether amazon.de fingerprints such deviations is unknown. Launching Chrome ourselves avoids the question.
- **Remote debugging and Chrome 136+.** `--remote-debugging-port` is ignored on the *default* data dir, so a `--user-data-dir` is required [C4]. We need one anyway (see #6). Security: any local process can connect to an open port. Keep it on 127.0.0.1 (the default), use a non-default port, and close Chrome after each run. **Never** pass `--remote-allow-origins=*`, which nodriver does by default [N1]. Chrome 142 gates public-site requests to loopback behind a permission prompt [C5], so amazon.de cannot probe the port from the page (unverified in practice).

### 2. TLS / HTTP2 fingerprint

- Driving the installed `google-chrome-stable` (own launch, Patchright `channel: "chrome"`, nodriver) sends Chrome's own ClientHello and HTTP/2 SETTINGS, because it *is* Chrome's network stack. Nothing to match or spoof.
- Chrome permutes ClientHello extension order since M110 [C6], so JA3 hashes vary between connections. JA4 sorts extensions and is stable [T1]. A bundled "Chrome for Testing"/Chromium build shares BoringSSL but differs in version and field trials. rebrowser lists the CfT user agent as a red flag [R2]. Use the branded Chrome.
- Camoufox presents a genuine Firefox TLS stack. That is consistent as long as its spoofed navigator claims Firefox. But its OS is randomized by default [F2], which risks a mismatch with the TCP/IP stack (Linux) (unverified).

### 3. Headless vs headful on Hyprland

- **Headful on a special workspace** (recommended). Omarchy's own rules already send windows to special workspaces with `o.window(match, { workspace = "special silent" })` [L1]. Chrome derives its window class from `--class` when given [C7]. The Wayland app_id mapping is expected but unverified, so check it with `hyprctl clients`. Add to `~/.config/hypr/…lua`:
  `o.window("^ShipmentTrackerChrome$", { workspace = "special:shiptracker silent" })`
  `silent` avoids focus stealing. To surface a challenge, `hyprctl dispatch` the window to the active workspace (Lua-era dispatcher syntax to be confirmed in the spike).
- Unknowns to measure in the spike: whether Chrome throttles timers/rendering for a window on a hidden special workspace (no frame callbacks), and what `document.visibilityState` reports there. Page loads and `DOM.getOuterHTML` should not depend on either.
- Running from a systemd user timer requires the Wayland session environment. uwsm exports it to the user manager. When the user is logged out, the run fails with `source-down` rather than falling back to headless.
- **Headless (fallback only):** `--headless` sets `navigator.webdriver` and the `HeadlessChrome` UA [C1][C2]. Fixing both takes a flag plus a UA override, which is a new inconsistency. Use it only if headful proves impractical, and measure challenge rates.

### 4. Amazon's bot defence (what is public)

- Amazon does not document bot defence for its retail site. The amazon-orders maintainers observe an **AWS WAF JavaScript challenge** during login, an **ACIC** puzzle (`/ax/aaut/verify/ap/challenge`), legacy image captchas and a "not a robot / enable JavaScript" page [A1][A3]. They also note that captchas come more often to **unknown devices** and after failed logins, and less often with 2FA on [A3].
- AWS WAF Bot Control (the public product; whether amazon.de runs this exact rule set is unverified) [W1]:
  - The `aws-waf-token` cookie carries "data from client browser interrogation, such as indications of automation and browser setting inconsistencies". With the SDK it also carries "mouse movements, key presses, and interactions with any HTML form" [W2].
  - The rules are `TGT_SignalAutomatedBrowser` → CAPTCHA, `TGT_SignalBrowserInconsistency` → CAPTCHA, `TGT_VolumetricSession` (abnormal requests per session in 5 min) → CAPTCHA, `TGT_TokenReuseIp/Asn/Country` (one token across >1 ASN/country, or >2 IPs, in 5 min) → Count/CAPTCHA/Block, and ML "coordinated activity" [W1].
  - Implications: no automation markers (§1), no proxies or VPN hopping, low per-session volume, one stable profile.
- Our pages carry no mouse or key input. A page-view-only session is also what a user who opens a bookmark and reads produces. Synthetic mouse jiggling adds a new signal and is **not** recommended (judgment, unverified).

### 5. Pacing (recommendation)

| Knob | Value | Rationale |
|---|---|---|
| Schedule | systemd timer `OnCalendar=hourly`, `RandomizedDelaySec=15min`, `Persistent=true` | Not on the exact hour; the delay is re-drawn each iteration [L2] |
| Quiet hours | no runs 00:00–06:30 local | Humans sleep; ha-paketbote has quiet hours [A2] |
| Pages per run | 1 history page + tracker pages for non-terminal Shipments, **max 6** | Terminal Statuses need no refresh (#4) |
| Delay between pages | uniform random 4–12 s, plus a random 1–3 s after load before reading | ha-paketbote uses 2–5 s [A2]; we are not in a hurry |
| Navigation | enter via `/gp/css/order-history`, reach tracker pages from the links found on it (same tab, real Referer) | Mimics a click path; constructed deep links are a pattern (judgment) |
| Daily cap | ~80 pages; halve after any challenge day | ha-paketbote caps 300/day [A2]; we need far less |
| Network | the machine's normal connection only | Token reuse across IP/ASN is a WAF signal [W1] |

### 6. Challenge policy

1. **Detect**, before parsing anything:
   - a URL under `/ap/signin`, `/ap/mfa`, `/ap/cvf/`, `/errors/validateCaptcha` or `/ax/aaut/verify/`;
   - a page with `form[name='signIn']`, `form#auth-mfa-form`, `form.cvf-widget-form-captcha` or `script[src*="awswaf.com"]`;
   - or a missing order-history root element [A1].
2. **Stop at once.** Do not submit anything and do not retry within the run. Close Chrome cleanly (`Browser.close`).
3. **Surface.** Write state `needs-login` (sign-in/OTP/CVF) or `challenge` (captcha/WAF/ACIC) for Source Amazon, with a timestamp. Pause Amazon runs until the user resolves it. DHL continues.
4. **Hand over.** The widget's action relaunches the *same* profile (same flags), moves the window to the current workspace and opens the challenged URL. The user completes sign-in with "Angemeldet bleiben" ticked [A2]. The helper watches for the order-history page and then resumes the schedule.
5. **Back-off.** Two challenges within 24 h pause Amazon polling for 24 h and halve the daily cap.
6. **Never:** captcha-solver services, OTP/TOTP automation, storing the password, clicking anything other than navigation.

## Newly surfaced questions

- Does Chrome's Wayland app_id follow `--class`? And what is the Lua-era `hyprctl dispatch` syntax to move a window out of a special workspace? (Spike, 5 minutes with `hyprctl clients`.)
- Does a headful Chrome on a hidden special workspace throttle page loads or report `visibilityState: hidden`?
- Launch per run vs one long-lived hidden Chrome: per run limits exposure of the debug port and saves RAM. Long-lived looks more like a normal browser session and keeps session cookies. Default to per run; revisit if Amazon asks for re-login often.
- How often does amazon.de re-prompt OTP for a trusted, stable profile on a static IP? (Measure over the spike's first weeks; log every challenge with a timestamp.)

## Sources

Local:
- [L1] `/usr/share/omarchy/default/hypr/apps/browser.lua`, `/usr/share/omarchy/default/hypr/helpers.lua` (`o.window` → `hl.window_rule`)
- [L2] `man systemd.timer` (`RandomizedDelaySec=`)

Chromium / Chrome / CDP:
- [C1] Chromium `content/child/runtime_features.cc` (AutomationControlled switches, port 0 rule): https://github.com/chromium/chromium/blob/main/content/child/runtime_features.cc
- [C2] Chromium `components/embedder_support/user_agent_utils.cc` (`GetUserAgentInternal`, brand list): https://github.com/chromium/chromium/blob/main/components/embedder_support/user_agent_utils.cc
- [C3] Chrome Headless mode: https://developer.chrome.com/docs/chromium/headless
- [C4] Changes to remote debugging switches (Chrome 136): https://developer.chrome.com/blog/remote-debugging-port
- [C5] Chrome Platform Status, Local network access restrictions: https://chromestatus.com/feature/5152728072060928
- [C6] Chrome Platform Status, TLS ClientHello extension permutation (M110): https://chromestatus.com/feature/5124606246518784
- [C7] Chromium `chrome/browser/shell_integration_linux.cc` (`GetProgramClassClass`, `--class`): https://github.com/chromium/chromium/blob/main/chrome/browser/shell_integration_linux.cc
- [D1] CDP protocol JSON (`Runtime.enable`, `Page.createIsolatedWorld`): https://github.com/ChromeDevTools/devtools-protocol/tree/master/json ; https://chromedevtools.github.io/devtools-protocol/

Frameworks:
- [P1] Patchright driver README (patches, stealth claims): https://github.com/Kaliiiiiiiiii-Vinyzu/patchright
- [P2] patchright-nodejs README, "Best Practice": https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs
- [P3] Playwright `chromiumSwitches.ts`: https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts
- [P4] Patchright `driver_patches/chromiumSwitchesPatch.ts`, `crPagePatch.ts`: https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/tree/main/driver_patches
- [P5] Playwright Browsers (headless shell vs new headless, channels): https://playwright.dev/docs/browsers
- [S2] puppeteer-extra-plugin-stealth README and `evasions/`: https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth
- [S3] puppeteer-extra issue #940: https://github.com/berstend/puppeteer-extra/issues/940
- [R1] rebrowser-patches README: https://github.com/rebrowser/rebrowser-patches
- [R2] rebrowser-bot-detector README: https://github.com/rebrowser/rebrowser-bot-detector
- [R3] Rebrowser blog, Runtime.Enable detection: https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries-61740
- [R4] Castle, "Why a classic CDP bot detection signal suddenly stopped working" (2025-08-28; cites V8 commits 61a90754, e08e9734) (secondary): https://blog.castle.io/why-a-classic-cdp-bot-detection-signal-suddenly-stopped-working-and-nobody-noticed/
- [F1] Camoufox README: https://github.com/daijro/camoufox
- [F2] Camoufox Python usage: https://camoufox.com/python/usage/
- [N1] nodriver 0.50.3 source (`core/config.py`, `core/tab.py`) and README: https://github.com/ultrafunkamsterdam/nodriver , https://pypi.org/project/nodriver/
- [N2] undetected-chromedriver README: https://github.com/ultrafunkamsterdam/undetected-chromedriver
- [T1] JA4 technical details: https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md
- [M1] Registry metadata, fetched 2026-09-29: npm `patchright` 1.63.0 (2026-09-08), `playwright-extra` 4.3.6 (2023-03-01), `puppeteer-extra-plugin-stealth` 2.11.2 (2023-03-01), `rebrowser-playwright` 1.52.0 (2025-05-09), `chrome-remote-interface` 0.34.0 (2026-02-09), `cheerio` 1.2.0 (2026-01-23); PyPI `nodriver` 0.50.3 (2026-05-13), `undetected-chromedriver` 3.5.5 (2024-02-17), `camoufox` 0.5.6 (2026-09-06), `zendriver` 0.17.0 (2026-09-27)
- [M2] GitHub releases: patchright v1.63.0 (2026-09-08), camoufox v156.0.1-beta.32 (2026-09-28): https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/releases , https://github.com/daijro/camoufox/releases

Amazon / AWS:
- [A1] amazon-orders `docs/waf.rst`, `docs/troubleshooting.rst` (WAF, ACIC, captcha): https://github.com/alexdlaird/amazon-orders/tree/main/docs
- [A2] ha-paketbote README / DOCS (jitter, caps, quiet hours, 1-Click, "Angemeldet bleiben"), via #4: https://github.com/BobMcGlobus/ha-paketbote
- [A3] amazon-orders troubleshooting, "Login Challenges": https://amazon-orders.readthedocs.io/troubleshooting.html
- [W1] AWS WAF Bot Control rule group: https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-bot.html
- [W2] AWS WAF token characteristics: https://docs.aws.amazon.com/waf/latest/developerguide/waf-tokens-details.html
