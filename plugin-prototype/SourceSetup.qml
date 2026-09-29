// PROTOTYPE (#18): the inside of one Source's setup, shared by all three
// onboarding variants. The variants disagree about WHERE this lives (wizard
// step, row on a Sources page, card in the list), not about what it says.
//   which: "dhl" | "amazon" | "mail" | "notify"
import QtQuick
import qs.Commons
import qs.Ui

Column {
  id: root
  property var host: null
  property string which: "dhl"
  property bool showIntro: true
  readonly property bool editing: labelField.activeFocus
  readonly property color fg: host ? host.fg : Color.foreground
  readonly property color muted: Qt.darker(fg, 1.5)
  readonly property string ff: host ? host.fontFamily : Style.font.family
  readonly property string st: !host ? "none" : which === "dhl" ? host.dhl.state : which === "mail" ? host.mail.state : "none"
  readonly property bool needsNode: host && !host.nodeOk && which !== "notify"
  spacing: Style.space(8)

  function glyph(state) {
    switch (state) {
      case "ok": return "\u{F05E0}"          // check-circle
      case "connecting": return "\u{F059F}"  // web
      case "code": return "\u{F059F}"
      case "syncing": return "\u{F04E6}"     // sync
      case "needs-login": return "\u{F033E}" // lock
      case "source-down": return "\u{F0164}" // cloud-off-outline
    }
    return "\u{F0766}"                       // circle-outline
  }
  function glyphColor(state) {
    return state === "ok" ? Color.accent : (state === "needs-login" || state === "source-down") ? Color.urgent : root.fg
  }
  function stateText(state, name) {
    switch (state) {
      case "connecting": return name === "DHL" ? "Chrome is open on the DHL login. Log in there (2FA too); the window closes by itself."
        : "Chrome is open on amazon.de. Sign in as " + name + " and tick “Angemeldet bleiben”; the window hides itself."
      case "syncing": return "Logged in · first sync running…"
      case "ok": return which === "dhl" ? "Connected · Incoming and Outgoing" : which === "mail" ? "Connected · read-only mail access" : "Connected"
      case "needs-login": return "Login expired · Shipments from here may be missing"
      case "source-down": return "Can't be read right now · retrying hourly"
    }
    return "Not connected"
  }

  component Para: Text {
    width: root.width
    wrapMode: Text.WordWrap
    color: root.muted; font.family: root.ff; font.pixelSize: Style.font.bodySmall
  }
  component StateLine: Row {
    property string state: "none"
    property string name: ""
    width: root.width
    spacing: Style.space(8)
    Text { id: g; text: root.glyph(parent.state); color: root.glyphColor(parent.state); font.family: root.ff; font.pixelSize: Style.font.icon }
    Text { width: parent.width - g.width - parent.spacing; wrapMode: Text.WordWrap; text: root.stateText(parent.state, parent.name); color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall; anchors.verticalCenter: parent.verticalCenter }
  }

  // ---- Node.js missing: the backend CLI can't run (#12). Manual add still works.
  Rectangle {
    visible: root.needsNode
    width: root.width
    height: nodeRow.implicitHeight + Style.space(14)
    radius: Style.cornerRadius
    color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.12)
    border.color: Color.urgent; border.width: 1
    Row {
      id: nodeRow
      x: Style.space(10); anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(8)
      Text { width: root.width - nodeBtn.width - Style.space(36); wrapMode: Text.WordWrap; anchors.verticalCenter: parent.verticalCenter
        text: "Connecting Sources needs Node.js, which isn't installed. Pasting tracking numbers works without it."
        color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall }
      Button { id: nodeBtn; anchors.verticalCenter: parent.verticalCenter; bordered: true; fontSize: Style.font.bodySmall
        text: root.host && root.host.nodeInstalling ? "Installing…" : "Install Node.js"
        onClicked: root.host.installNode() }
    }
  }

  // ================================================================ DHL
  Column {
    visible: root.which === "dhl"
    width: root.width
    spacing: Style.space(8)
    Para { visible: root.showIntro; text: "Finds every DHL parcel on your dhl.de account, Incoming and Outgoing. You log in once in a separate Chrome window; after that it refreshes hourly without a browser." }
    StateLine { visible: root.st !== "none"; state: root.st; name: "DHL" }
    Row {
      spacing: Style.space(6)
      Button { visible: root.st === "none" || root.st === "needs-login"; enabled: !root.needsNode; selected: true; text: root.st === "none" ? "Log in to DHL" : "Log in again"; fontSize: Style.font.bodySmall; onClicked: root.host.login("dhl") }
      Button { visible: root.st === "connecting"; bordered: true; text: "Cancel"; fontSize: Style.font.bodySmall; onClicked: root.host.cancel("dhl") }
      Button { visible: root.st === "source-down"; bordered: true; text: "Retry now"; fontSize: Style.font.bodySmall; onClicked: root.host.refresh() }
      Button { visible: root.st === "ok" || root.st === "needs-login" || root.st === "source-down"; bordered: true; text: "Disconnect"; fontSize: Style.font.bodySmall; onClicked: root.host.remove("dhl") }
    }
  }

  // ================================================================ Amazon
  Column {
    visible: root.which === "amazon"
    width: root.width
    spacing: Style.space(8)
    Para { visible: root.showIntro; text: "Reads the order history of each Amazon account in its own Chrome profile, hourly between 07:00 and 23:00. Add one entry per account, e.g. a personal and a business account." }

    Repeater {
      model: root.host ? root.host.accounts : []
      delegate: Rectangle {
        required property var modelData
        width: root.width
        height: acctCol.implicitHeight + Style.space(12)
        radius: Style.cornerRadius
        color: Style.normalFillFor(root.fg, Color.accent, Color.urgent)
        Column {
          id: acctCol
          x: Style.space(10); width: parent.width - Style.space(20)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(4)
          Item {
            width: parent.width; height: Math.max(acctName.implicitHeight, acctBtns.implicitHeight)
            Text { id: acctGlyph; anchors.verticalCenter: parent.verticalCenter; text: root.glyph(modelData.state); color: root.glyphColor(modelData.state); font.family: root.ff; font.pixelSize: Style.font.icon }
            Text { id: acctName; anchors.left: acctGlyph.right; anchors.leftMargin: Style.space(8); anchors.verticalCenter: parent.verticalCenter
              text: "Amazon · " + modelData.label; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body; font.bold: true }
            Row {
              id: acctBtns
              anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(4)
              Button { visible: modelData.state === "needs-login"; selected: true; text: "Log in"; fontSize: Style.font.bodySmall; onClicked: root.host.login("amazon:" + modelData.label) }
              Button { visible: modelData.state === "connecting"; bordered: true; text: "Cancel"; fontSize: Style.font.bodySmall; onClicked: root.host.cancel("amazon:" + modelData.label) }
              PanelActionButton { visible: modelData.state !== "connecting"; iconText: "\u{F0A7A}"; tooltipText: "Remove this account and its Chrome profile"; foreground: root.fg; hoverColor: Color.urgent
                onClicked: root.host.remove("amazon:" + modelData.label) }
            }
          }
          Text { visible: modelData.state !== "ok"; width: parent.width; wrapMode: Text.WordWrap; text: root.stateText(modelData.state, modelData.label)
            color: root.muted; font.family: root.ff; font.pixelSize: Style.font.caption }
        }
      }
    }

    // Add form: open by default before the first account, behind a button after.
    readonly property bool formOpen: root.host && (root.host.accounts.length === 0 || root.host.addingAccount)
    Button {
      visible: !parent.formOpen
      bordered: true; iconText: "\u{F0415}"; text: "Add another Amazon account"; fontSize: Style.font.bodySmall
      onClicked: root.host.addingAccount = true
    }

    Column {
      visible: parent.formOpen
      width: root.width
      spacing: Style.space(8)

      // Conditions-of-Use disclosure. Opt-in is per account: the business
      // account may not be the user's own to risk (#14).
      Rectangle {
        width: root.width
        height: riskCol.implicitHeight + Style.space(16)
        radius: Style.cornerRadius
        color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.10)
        border.color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.7); border.width: 1
        Column {
          id: riskCol
          x: Style.space(10); width: parent.width - Style.space(20)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(6)
          Row {
            spacing: Style.space(6)
            Text { text: "\u{F0026}"; color: Color.urgent; font.family: root.ff; font.pixelSize: Style.font.icon }
            Text { text: "Amazon doesn't allow this"; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body; font.bold: true; anchors.verticalCenter: parent.verticalCenter }
          }
          Text { width: parent.width; wrapMode: Text.WordWrap; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
            text: "amazon.de's Conditions of Use forbid robots and data-mining tools. The tracker reads this account's orders the way you would, in a real Chrome window, but Amazon may still ask for captchas or restrict the account. Only connect an account you accept that risk for." }
          Toggle {
            width: parent.width
            label: "I accept this risk for this account"
            checked: root.host ? root.host.draftRisk : false
            foreground: root.fg; fontFamily: root.ff; titleSize: Style.font.bodySmall
            onClicked: root.host.draftRisk = !root.host.draftRisk
          }
        }
      }

      TextField {
        id: labelField
        width: root.width
        placeholderText: "Label, e.g. Personal or Business"
        text: root.host ? root.host.draftLabel : ""
        onTextChanged: if (root.host && root.host.draftLabel !== text) root.host.draftLabel = text
        foreground: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
        Keys.onEscapePressed: focus = false
      }

      Para {
        text: "A Chrome window opens on amazon.de. Sign in and tick “Angemeldet bleiben” so the login lasts. That window becomes the tracker's own profile and can buy with 1-Click, so don't shop in it."
      }

      readonly property string label: root.host ? root.host.draftLabel.trim() : ""
      readonly property bool taken: root.host && root.host.account(label) !== null
      Text { visible: parent.taken; text: "An account with this label exists"; color: Color.urgent; font.family: root.ff; font.pixelSize: Style.font.caption }
      Row {
        spacing: Style.space(6)
        Button {
          enabled: parent.parent.label !== "" && !parent.parent.taken && root.host.draftRisk && !root.needsNode
          opacity: enabled ? 1 : 0.45
          selected: true; text: "Sign in to Amazon"; fontSize: Style.font.bodySmall
          onClicked: root.host.addAccount(root.host.draftLabel)
        }
        Button { visible: root.host && root.host.accounts.length > 0; bordered: true; text: "Cancel"; fontSize: Style.font.bodySmall
          onClicked: { root.host.addingAccount = false; root.host.draftLabel = ""; root.host.draftRisk = false } }
      }
    }
  }

  // ================================================================ Mail
  Column {
    visible: root.which === "mail"
    width: root.width
    spacing: Style.space(8)
    Para { visible: root.showIntro; text: "Optional. Reads delivery mails in your Microsoft 365 mailbox, read-only, to catch Amazon Orders from accounts not connected above. Signs in through the ms-365-mcp-server with a device code." }
    StateLine { visible: root.st !== "none" && root.st !== "code"; state: root.st; name: "Mail" }

    // Device code, shown right in the popup.
    Rectangle {
      visible: root.st === "code"
      width: root.width
      height: codeCol.implicitHeight + Style.space(16)
      radius: Style.cornerRadius
      color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.12)
      border.color: Color.accent; border.width: 1
      Column {
        id: codeCol
        x: Style.space(10); width: parent.width - Style.space(20)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(6)
        Text { text: "Open microsoft.com/devicelogin and enter"; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall }
        Text { anchors.horizontalCenter: parent.horizontalCenter; text: root.host ? root.host.deviceCode : ""; color: Color.accent; font.family: root.ff; font.pixelSize: Style.font.display; font.bold: true; font.letterSpacing: Style.space(3) }
        Row {
          anchors.horizontalCenter: parent.horizontalCenter
          spacing: Style.space(6)
          Button { id: copyBtn; property bool copied: false; bordered: true; iconText: "\u{F018F}"; text: copied ? "Copied" : "Copy code"; fontSize: Style.font.bodySmall; onClicked: copied = true }
          Button { selected: true; iconText: "\u{F03CC}"; text: "Open page"; fontSize: Style.font.bodySmall; onClicked: Qt.openUrlExternally(root.host.deviceUrl) }
          Button { bordered: true; text: "Cancel"; fontSize: Style.font.bodySmall; onClicked: root.host.cancel("mail") }
        }
        Text { anchors.horizontalCenter: parent.horizontalCenter; text: "Sign in with your work account · waiting…"; color: root.muted; font.family: root.ff; font.pixelSize: Style.font.caption }
      }
    }
    Row {
      spacing: Style.space(6)
      Button { visible: root.st === "none" || root.st === "needs-login"; enabled: !root.needsNode; selected: true; text: root.st === "none" ? "Connect mail" : "Sign in again"; fontSize: Style.font.bodySmall; onClicked: root.host.login("mail") }
      Button { visible: root.st === "ok" || root.st === "needs-login"; bordered: true; text: "Disconnect"; fontSize: Style.font.bodySmall; onClicked: root.host.remove("mail") }
    }
  }

  // ================================================================ Notifications
  Toggle {
    visible: root.which === "notify"
    width: root.width
    label: "Notify on Status changes"
    description: "Out for delivery, Ready for pickup, Problems, delays and new Incoming Shipments. Never for what the first sync finds."
    checked: root.host ? root.host.notificationsOn : true
    foreground: root.fg; fontFamily: root.ff
    onClicked: root.host.toggleNotifications()
  }
}
