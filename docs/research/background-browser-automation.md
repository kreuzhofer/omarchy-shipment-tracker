# Background browser automation on Omarchy

Research for [#6](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/6), part of map [#1](https://github.com/kreuzhofer/omarchy-shipment-tracker/issues/1).
Question: how can the widget run browser automation hourly in the background to discover Shipments from a Source (dhl.de, amazon.de), and which approach should the prototypes use?

Researched 2026-09-29 against Omarchy as installed locally, Claude Code 2.1.283 and Google Chrome 154.0.8037.57.

## Answer

- **Prototype (b) first: a deterministic Playwright script driving the installed Google Chrome (`channel: "chrome"`) with a dedicated persistent profile** (for example `~/.local/share/omarchy-shipment-tracker/chrome-profile`). The user signs in once in a *headed* window from a setup command. Hourly runs are *headless* (new headless mode), reuse the profile's cookies, need no LLM tokens, and write a cache file that the QML widget reads.
- **When a run hits a login page, 2FA or a captcha, it does not try to solve it.** It writes a `needs-login` error state for that Source. The widget shows it, and one click relaunches the same profile headed so the user can sign in. This is the one route that none of the three approaches can automate away.
- **(a) The default agent with Claude in Chrome is not suited to hourly background runs.** It drives the user's real, visible Chrome, it needs a `/login` subscription session (it is disabled with an API key or `setup-token`), and by design it stops at login pages and captchas. `omarchy-agent-prompt` opens an interactive TUI window, so it cannot be invoked headlessly either. An agent is still useful for *writing and repairing* the Playwright scraper, and optionally as a slow fallback: `claude -p` with Playwright MCP pointed at the same dedicated profile.
- **(c) Reusing cookies from the user's normal Chrome profile should be rejected.** Chrome 136+ refuses CDP on the default data directory. Playwright warns against pointing at the main profile. The profile is locked while Chrome runs. Decrypting the cookie DB out-of-process (the v11 key sits in gnome-libsecret) is the same technique as infostealer malware, and it breaks whenever Chrome changes.
- **Invocation:** the helper script runs from a **systemd user timer** (`Persistent=true` catches up after suspend), or from a QML `Timer` + `Process` as the weather plugin does. Either way it writes JSON, and the widget only reads it. The Runtime-shape ticket should choose between the two.

## Comparison

| | (a) Default agent + Claude in Chrome | (a') `claude -p` + Playwright MCP, dedicated profile | (b) Playwright script, dedicated profile | (c) Cookies from normal Chrome profile |
|---|---|---|---|---|
| Disturbs desktop? | **Yes**: runs in the user's visible Chrome and opens a tab group [1] | No, if `--headless` [6] | No: headless is the default [5] | No, but it contends with the running Chrome for the profile lock [5] |
| Auth persistence | The user's real sessions [1] | Persistent profile dir [6] | Persistent profile dir (`launchPersistentContext`) [5] | Whatever the user's Chrome holds; breaks if the password store changes [11] |
| 2FA / captcha | "pauses and asks you to handle it manually" [1]; cannot be unattended | The agent sees it but must not solve it; surface to the user | Detect and surface; user re-auths headed in the same profile | Same as (b), but re-auth happens in the user's own Chrome |
| Bot-detection risk | Lowest: a real browser and real fingerprint (unverified) | Medium: automation tells such as `navigator.webdriver` [9] | Medium; lower with `channel: "chrome"` than with bundled Chromium (unverified) | Cookie replay from another client/fingerprint is suspicious (unverified) |
| Cost per run | LLM tokens; see [cost](#cost-per-run) | LLM tokens | ~0 (CPU only) | ~0 |
| Dependencies | Claude Code + subscription `/login`, Chrome extension, Chrome running [1] | Claude Code, Node, `@playwright/mcp` | Node (present via mise), `playwright` npm package, Google Chrome (present) | Python/Node + libsecret access + SQLite; fragile |
| Invocation from plugin | Not headless: `omarchy-agent-prompt` opens a TUI window [L2][L3] | `claude -p … --output-format json` in a helper [2] | `node fetch.mjs` from a timer or `Process` [L5] | Same as (b) |

## Details

### What Omarchy gives us (local, read-only)

- **`omarchy-default-agent`** prints the chosen agent from `~/.config/omarchy/defaults/agent` (here: `claude`), or sets and installs one via mise [L1]. It only reports which agent is chosen. It has no headless mode.
- **`omarchy-agent-prompt "<prompt>"`** execs `omarchy-agent --prompt`. That script maps the agent to its interactive CLI with auto-approve flags (for Claude: `claude --permission-mode auto -- "<prompt>"`) and then runs `omarchy-launch-tui --app-id=org.omarchy.agent …`. This **opens a terminal window**; `--inline` runs it in the current TTY [L2][L3]. It never uses `claude -p`, so it does not suit background use. A background helper would call `claude -p` itself, perhaps choosing the CLI from `omarchy-default-agent`'s output. Other agents would need their own non-interactive modes (for example `crush run`, which `omarchy-agent` already uses [L3]).
- **`omarchy-default-browser`** reads `xdg-settings get default-web-browser` (here: `chrome` → `google-chrome.desktop`) [L4].
- **`omarchy-launch-browser [url]`** resolves the default browser's `Exec=` and starts it via `systemd-run --user … uwsm-app`, then focuses it [L6]. This is the right call for the widget's "open the Source's detail page" click. It is not suited to automation.
- **Chrome flags**: `~/.config/chrome-flags.conf` contains `--password-store=gnome-libsecret`, plus Omarchy's `--load-extension=` list [L7]. An Omarchy migration pins libsecret because on Hyprland the auto-detected backend can fall back to `basic` (v10), which "makes existing cookies and saved passwords undecryptable… the user is logged out of everything" [L8]. A dedicated profile launched by Playwright does **not** read `chrome-flags.conf` (that file is read by the Arch launcher wrapper, unverified), so the helper should pass `--password-store=gnome-libsecret` explicitly. Otherwise the dedicated profile might silently log out when the backend changes.
- **Shell plugins** run unsandboxed inside `omarchy-shell` [L9]. The weather plugin shows the pattern: a `Timer { interval: refreshMinutes*60*1000; repeat: true; triggeredOnStart: true }` triggers a Quickshell `Process { command: [...]; stdout: StdioCollector {...} }` [L5].
- **Present on this machine**: `google-chrome-stable`, Node 26 + `npx` (mise), `python3`, `secret-tool`, `gnome-keyring-daemon` (running), Claude Code 2.1.283, the Claude in Chrome native host manifest in `~/.config/google-chrome/NativeMessagingHosts/` [L10]. **Not present**: the `playwright` npm package, Xvfb and `cage`.

### (a) Default agent driving a browser

**Claude in Chrome** (`claude --chrome`, or `-p` with Chrome enabled):
- "Browser actions run in a visible Chrome window in real time. When Claude encounters a login page or CAPTCHA, it pauses and asks you to handle it manually." Claude opens new tabs in a tab group in the user's Chrome [1]. This disturbs the desktop, and it only works while Chrome is running and the extension's service worker is awake. The docs list "Connection drops during long sessions… service worker can go idle" [1].
- It requires a direct Anthropic plan and `/login`: "If you authenticate with an API key or a long-lived token from `claude setup-token`, Claude Code keeps Chrome integration off, even when you pass `--chrome`" [1]. `--bare`, the recommended mode for scripts, never reads OAuth credentials [2], so it cannot use Chrome.
- Site permissions come from the extension, and first use needs an interactive dialog [1]. The Claude in Chrome extension has its own "scheduled tasks" feature, but those run "as long as Chrome is open" [3]. It is the same visible browser, and the user's Chrome would have to stay open.
- Verdict: good for one-off exploration of dhl.de / amazon.de pages while designing a scraper. Not for the hourly run.

**Agent + Playwright MCP (a')**: Playwright MCP defaults to a persistent profile under `~/.cache/ms-playwright/mcp-{channel}-{hash}`, overridable with `--user-data-dir`, and supports `--headless` [6]. It reads pages through accessibility snapshots rather than screenshots [6]. `claude -p "…" --mcp-config playwright.json --allowedTools "mcp__playwright__*" --output-format json --json-schema '<Shipment schema>' --max-budget-usd 0.25 --permission-prompts none` is a workable unattended invocation. Every flag is documented [2], and `--max-budget-usd` exists in the local `claude --help`. It shares (b)'s profile and detection profile, but adds token cost, nondeterminism and a subscription or API dependency. Use it as a fallback or authoring aid, not as the main path.

### (b) Playwright with a dedicated persistent Chrome profile

- `browserType.launchPersistentContext(userDataDir, { channel: "chrome", headless: true })` keeps cookies and storage in `userDataDir`. `headless` defaults to true. Only one instance can use a data dir at a time [5]. Playwright warns: pointing `userDataDir` at Chrome's main profile "may result in pages not loading or the browser exiting… Create and use a separate directory" [5].
- Chrome's headless mode is the real browser since Chrome 112. As of 132 the old implementation lives only in the separate `chrome-headless-shell` [7]. So headless runs the same code as headed Chrome, and the user can open the profile headed for login.
- Alternative to a profile dir: `storageState` files ("cookies, local storage, IndexedDB"). Playwright warns the file "may contain sensitive cookies… that could be used to impersonate you". sessionStorage is not persisted [8]. A persistent profile is simpler, and it keeps the encryption key in libsecret instead of in a plaintext JSON file.
- **Login flow:** a `setup` or `login <source>` subcommand launches the same profile with `headless: false` on the Source's login page and waits until the user reaches the logged-in page. Hourly headless runs detect a redirect to the sign-in URL or a captcha page and exit with `needs-login`. This is where "surface to user" happens (map: *Error states surfaced in the widget*).
- **Detection:** `navigator.webdriver` is true under WebDriver/automation control [9]. Old headless put `HeadlessChrome` in the UA (secondary source [10]). amazon.de and dhl.de anti-bot behaviour was **not verified**; only a prototype can measure it. Mitigations to test: branded Chrome (`channel: "chrome"`), a low request rate (hourly, a few pages), a stable profile and IP, and if headless gets challenged, headed Chrome placed off-screen (for example a Hyprland special workspace; unverified).
- **Terms:** Amazon's Conditions of Use are understood to prohibit "robots, data mining, or similar data gathering and extraction tools". The amazon.de page returned 503 when fetched, so this is **unverified here**. The user should accept that risk for their own account. Hourly automation of one's own order page is low-volume, but it is still automation.

### (c) Reusing the normal Chrome profile's cookies

- Chrome 136+: `--remote-debugging-port`/`--remote-debugging-pipe` "will no longer be respected if attempting to debug the default Chrome data directory", which was introduced because attackers used CDP to extract cookies [4]. So a CDP attach to the user's profile is not possible.
- Launching Playwright on the main profile is warned against [5], and it cannot run while the user's Chrome holds the profile lock [5].
- Reading the `Cookies` SQLite DB directly: on Linux, v11 cookies use a key held in the Secret Service (gnome-libsecret here), PBKDF2 with salt `saltysalt`, 1 iteration. The v10 fallback uses the hard-coded password `peanuts` [12][13]. App-Bound Encryption is a Windows feature [14]. So decryption *is* technically possible on Linux, but it is exactly the infostealer technique Chrome is working to close, and it would break with any os_crypt change. Replaying the cookies in another client also presents a different fingerprint (unverified risk of a forced re-login).
- Verdict: reject. The one advantage (no separate login) is not worth it.

### Cost per run

- (b) and (c): no LLM tokens.
- (a)/(a'): prices per million input/output tokens are Haiku 4.5 $1/$5, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20 [15]. An average 10 kB page is about 2,500 tokens [15]. A browsing agent re-sends its growing context every turn, and screenshots are billed as image input [15]. **Estimate (unverified):** 5–15 turns across two Sources gives 50k–200k input tokens per run, about $0.10–$0.40 on Sonnet 5.5 before caching. At 24 runs a day that is $70–$290 a month on API billing, or a steady drain on subscription limits. `claude -p --output-format json` reports `total_cost_usd` per run [2], so a prototype can measure the real cost.

### How the plugin invokes it

1. A helper (e.g. `bin/shipment-tracker-fetch`, Node + Playwright) runs a Source's scraper against the dedicated profile and writes `~/.cache/omarchy-shipment-tracker/shipments.json`, including a per-Source error state (`ok`, `needs-login`, `captcha`, `source-down`).
2. Scheduling options:
   - A **systemd user timer** (`OnCalendar=hourly`, `Persistent=true`). This catches up on runs missed during suspend: "the service unit is triggered immediately if it would have been triggered at least once during the time when the timer was inactive" [L11]. It also runs when the shell is not.
   - Or a **QML `Timer` + `Process`** like the weather plugin [L5]. This is simpler, but it only runs while the shell runs and does not catch up after suspend without extra code.
3. The widget watches or reads the JSON. A `needs-login` state appears as a clickable row that runs `shipment-tracker-fetch login dhl|amazon` (a headed window).
4. The detail-page click uses `omarchy-launch-browser <url>` [L6].

## Newly surfaced questions

- Do amazon.de and dhl.de challenge headless branded Chrome with a persistent profile at hourly frequency? How long do sessions last before 2FA is asked again? (Prototype.)
- Does the Arch `google-chrome-stable` wrapper read `chrome-flags.conf`, and does a dedicated profile need `--password-store=gnome-libsecret` passed explicitly? Where does Chrome look for native-messaging manifests with a custom `--user-data-dir` (relevant only if (a) is used with the dedicated profile)?
- Runtime shape: systemd user timer vs QML Timer (already an open map item). The timer is favoured for suspend catch-up.
- Should the agent path (a') exist at all in v1, e.g. as a "repair scraper" or first-run exploration aid, given its cost and the `/login` requirement?

## Sources

Local (read-only):
- [L1] `/usr/share/omarchy/bin/omarchy-default-agent`
- [L2] `/usr/share/omarchy/bin/omarchy-agent-prompt`
- [L3] `/usr/share/omarchy/bin/omarchy-agent`
- [L4] `/usr/share/omarchy/bin/omarchy-default-browser`
- [L5] `/usr/share/omarchy/shell/plugins/panels/weather/Panel.qml` (Process at ~L333, refresh Timer at ~L469)
- [L6] `/usr/share/omarchy/bin/omarchy-launch-browser`
- [L7] `~/.config/chrome-flags.conf`; `/usr/share/omarchy/config/chromium-flags.conf`
- [L8] `/usr/share/omarchy/migrations/1784508556.sh`
- [L9] `/usr/share/omarchy/shell/README.md` (plugin install, unsandboxed warning, IPC)
- [L10] `~/.config/google-chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json`; `claude --help`; `google-chrome-stable --version`
- [L11] `man systemd.timer` (`Persistent=`)

Web:
- [1] Claude Code, Use Claude Code with Chrome: https://code.claude.com/docs/en/chrome
- [2] Claude Code, Run Claude Code programmatically: https://code.claude.com/docs/en/headless
- [3] Getting started with Claude in Chrome: https://support.claude.com/en/articles/12012173-getting-started-with-claude-in-chrome
- [4] Chrome for Developers, Changes to remote debugging switches (Chrome 136): https://developer.chrome.com/blog/remote-debugging-port
- [5] Playwright, BrowserType.launchPersistentContext / connectOverCDP: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
- [6] Playwright MCP README: https://github.com/microsoft/playwright-mcp
- [7] Chrome for Developers, Chrome Headless mode: https://developer.chrome.com/docs/chromium/headless
- [8] Playwright, Authentication (storageState): https://playwright.dev/docs/auth
- [9] W3C WebDriver, `navigator.webdriver`: https://w3c.github.io/webdriver/#interface
- [10] Castle, Detecting headless Chrome (secondary): https://blog.castle.io/how-to-detect-headless-chrome-bots-instrumented-with-puppeteer-2/
- [11] Chromium, Linux password storage: https://github.com/chromium/chromium/blob/main/docs/linux/password_storage.md
- [12] Chromium source, `posix_key_provider.cc` (v10 / "peanuts"): https://github.com/chromium/chromium/blob/main/components/os_crypt/async/browser/posix_key_provider.cc
- [13] Chromium source, `freedesktop_secret_key_provider.cc` (v11, libsecret/KWallet): https://github.com/chromium/chromium/blob/main/components/os_crypt/async/browser/freedesktop_secret_key_provider.cc
- [14] Google Security Blog, Improving the security of Chrome cookies on Windows (App-Bound Encryption): https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html
- [15] Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
