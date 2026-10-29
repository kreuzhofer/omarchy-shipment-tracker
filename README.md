# Shipment tracker for Omarchy

An Omarchy bar widget that lists your recent parcels, incoming and outgoing, and
where they are: Announced, In transit, Out for delivery, Ready for pickup,
Problem, Delivered and so on, with the carrier's delivery estimate. Click the
icon in the bar for the list; parcels that need you (a failed delivery, a
parcel waiting at a Packstation) stay on top.

It finds Shipments in:

- **DHL**: your dhl.de account (Incoming and Outgoing), or any DHL tracking
  number you paste. While a parcel is out for delivery it shows how many stops
  are left.
- **DPD**: tracking numbers you paste or that arrive by mail, looked up
  anonymously on dpd.de.
- **Amazon**: the order history of one or more amazon.de accounts (for example
  a personal and a business account), or an order ID you paste.
- **Microsoft 365 mail** (optional): reads delivery mails, read-only, to find
  Amazon orders and DHL and DPD tracking numbers from accounts you didn't
  connect.

Every Source is optional. Without any, you can still paste DHL and DPD
tracking numbers and Amazon order IDs by hand.

The DHL, DPD and Amazon readers target the German sites (dhl.de, dpd.de,
amazon.de).

## Requirements

- Omarchy with shell plugins (`omarchy plugin`).
- Node.js 22 or newer, with npm. The widget offers to install it
  (`omarchy pkg add nodejs npm`) if it's missing.
- Google Chrome (`google-chrome-stable`) to log in to DHL and Amazon. Not
  needed for pasted numbers, DPD or mail.
- A systemd user session (standard on Omarchy) for the background refresh.

## Install

```sh
omarchy plugin add https://github.com/kreuzhofer/omarchy-shipment-tracker.git --enable
```

When asked, pick the bar section for the widget (it defaults to the right).
Without `--enable`, enable it later with
`omarchy plugin enable kreuzhofer.shipment-tracker`, or from the bar's plugin
settings. The widget has one setting, desktop notifications (on by default).

Update with `omarchy plugin update kreuzhofer.shipment-tracker`.

## First run

Click the widget, then **Connect Sources** (or the gear icon) to open the
Sources page:

- **DHL**: **Log in to DHL** opens a separate Chrome window with its own
  profile. Log in there (2FA too); the window closes by itself. After that it
  refreshes without a browser.
- **Amazon**: add one entry per account, read and accept the risk notice (see
  below), then **Sign in to Amazon** in the Chrome window that opens. Tick
  "Angemeldet bleiben" so the login lasts. That window becomes the tracker's
  own Chrome profile for this account; don't shop in it.
- **Microsoft 365 mail**: **Connect mail** shows a device code to enter at
  microsoft.com/devicelogin.

Or paste a tracking number or Amazon order ID in the field at the bottom of the
list.

## What gets installed

- **The plugin folder**: `~/.config/omarchy/plugins/kreuzhofer.shipment-tracker`,
  a git clone of this repository. The bar widget (QML) is at the root; the
  `cli/` folder holds the `shipment-tracker` command-line tool (Node.js) that
  fetches and stores everything. Tests, docs and dev scripts in `test/`,
  `docs/`, `scripts/` and `.agents/` are not loaded by the shell.
- **systemd user timers**: when the shell starts with the widget enabled, it
  installs `shipment-tracker-refresh.timer` (hourly) and
  `shipment-tracker-refresh-close.timer` (every 15 minutes; does nothing unless
  a DHL parcel is out for delivery or due today), with their services, in
  `~/.config/systemd/user/`. The Sources page has **Uninstall timer**.
- **The mail server**, only once you connect Microsoft 365 mail: the
  [Softeria ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server),
  pinned to an exact version (`mail-server/package.json`) and lockfile
  (`mail-server/package-lock.json`), installed with
  `npm ci --omit=dev --no-bin-links` into `mail-server/node_modules` inside the
  plugin folder. Its one install script allowed is keytar's prebuilt binary
  (for the keyring). It's never committed and is re-created after an update if
  needed.

Nothing is installed with sudo, and no system files are changed.

## Privacy: where your data lives

Everything stays on your machine:

- `~/.local/state/omarchy-shipment-tracker/`: the Shipment list, Source
  health, the DHL login tokens, cached product thumbnails and logs. Logs carry
  counts, never tracking numbers.
- `~/.local/share/omarchy-shipment-tracker/`: the dedicated Chrome profiles for
  the DHL and Amazon logins. Your normal Chrome profile is never touched.
- The system keyring: the keys of those Chrome profiles, and the Microsoft 365
  sign-in, kept by the mail server.

The tracker talks only to dhl.de, dpd.de, amazon.de and (through the mail
server) Microsoft 365. Mail access is read-only.

## Amazon Conditions of Use

amazon.de's Conditions of Use forbid robots and data-mining tools. The tracker
reads your order history the way you would, in a real Chrome window, at most
hourly between 07:00 and 23:00, but Amazon may still ask for captchas or
restrict the account. Only connect an account you accept that risk for. The
Sources page asks you to accept it per account.

## Remove

1. Sign out of what you connected (optional, but it deletes the logins): on the
   Sources page, **Disconnect** DHL and Microsoft 365 mail and remove each
   Amazon account.
2. Remove the background refresh: **Uninstall timer** on the Sources page, or

   ```sh
   node ~/.config/omarchy/plugins/kreuzhofer.shipment-tracker/cli/shipment-tracker.mjs uninstall
   ```

   Do this before removing the plugin. While the widget is enabled, it
   installs the timers again when the shell starts.
3. Remove the plugin:

   ```sh
   omarchy plugin remove kreuzhofer.shipment-tracker
   ```

4. Delete its data:

   ```sh
   rm -rf ~/.local/state/omarchy-shipment-tracker ~/.local/share/omarchy-shipment-tracker
   ```

## Development

The repository root is the plugin folder. `npm test` runs the test suite
(Node.js built-in test runner, no dependencies). `scripts/dev-install.sh`
copies the working tree into the Omarchy plugin folder for a live check
(not over a git-managed install). The plugin folder may not contain
symlinks, so `scripts/link-claude-skills.sh` links the agent skills in
`.agents/skills` into `.claude/skills` locally, untracked.

## License

[MIT](LICENSE)
