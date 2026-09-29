// The Microsoft 365 mail row's setup (#18 §5, #34): what it does, its state,
// and Connect mail. The Login runs `login mail` as a transient unit
// (Store.login); once Softeria hands out a device code, the CLI writes it to
// sources.json and the row shows it in large type with Copy code, Open page
// and Cancel until the user has signed in (15 min at most). Disconnect asks
// inline first (RemoveConfirm, #32) and logs out through Softeria.
import QtQuick
import qs.Commons
import qs.Ui

Column {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  readonly property var connection: store ? store.connection("mail") : null
  readonly property string health: connection && connection.health ? connection.health : "not-set-up"
  readonly property var login: store ? store.activeLogin : null
  readonly property bool loggingIn: !!login && login.key === "mail"
  readonly property var record: loggingIn && login.connection ? login.connection.login : null
  readonly property string phase: record ? record.phase : ""
  readonly property bool showsCode: phase === "code" && !!record.code
  readonly property bool canLogIn: !!store && !login && store.nodeOk !== false
  readonly property bool connected: health === "ok" || health === "needs-login" || health === "source-down"
  readonly property bool confirming: !!store && (store.confirmingRemoval === "mail" || store.removingKey === "mail")
  property bool copied: false
  onShowsCodeChanged: copied = false
  spacing: Style.space(8)

  NodeNotice { width: root.width; store: root.store; fg: root.fg; ff: root.ff }

  Text {
    width: root.width
    wrapMode: Text.WordWrap
    text: "Optional. Reads delivery mails in your Microsoft 365 mailbox, read-only, to catch Amazon Orders from accounts not connected above and DHL numbers DHL doesn\u2019t list under your name. Mail never sets a Status. Signs in through the ms-365-mcp-server with a device code."
    color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.bodySmall
  }

  ConnectionLine {
    visible: !root.showsCode && line !== ""
    width: root.width
    store: root.store; fg: root.fg; ff: root.ff
    connectionKey: "mail"
  }

  // The device code, in the row itself.
  Rectangle {
    visible: root.showsCode
    width: root.width
    height: codeColumn.implicitHeight + Style.space(16)
    radius: Style.cornerRadius
    color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.12)
    border.color: Color.accent
    border.width: 1
    Column {
      id: codeColumn
      x: Style.space(10)
      width: parent.width - Style.space(20)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(6)
      Text {
        width: parent.width
        wrapMode: Text.WordWrap
        text: "Open " + String(root.record && root.record.url ? root.record.url : "").replace(/^https:\/\//, "") + " and enter"
        color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
      }
      Text {
        anchors.horizontalCenter: parent.horizontalCenter
        text: root.record && root.record.code ? root.record.code : ""
        color: Color.accent; font.family: root.ff; font.pixelSize: Style.font.display; font.bold: true
        font.letterSpacing: Style.space(3)
      }
      Row {
        anchors.horizontalCenter: parent.horizontalCenter
        spacing: Style.space(6)
        Button {
          bordered: true; iconText: "\u{F018F}"; fontSize: Style.font.bodySmall
          text: root.copied ? "Copied" : "Copy code"
          onClicked: { root.store.copyText(root.record.code); root.copied = true }
        }
        Button {
          selected: true; iconText: "\u{F03CC}"; text: "Open page"; fontSize: Style.font.bodySmall
          onClicked: Qt.openUrlExternally(root.record.url)
        }
        Button {
          bordered: true; text: "Cancel"; fontSize: Style.font.bodySmall
          onClicked: root.store.cancelLogin()
        }
      }
      Text {
        anchors.horizontalCenter: parent.horizontalCenter
        text: root.store ? root.store.mailCodeHint : ""
        color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
      }
    }
  }

  Row {
    // Nothing to offer while the code shows or the first sync runs.
    visible: !(root.loggingIn && (root.showsCode || root.phase === "syncing"))
    spacing: Style.space(6)
    Button {
      visible: !root.loggingIn && (root.health === "not-set-up" || root.health === "needs-login")
      enabled: root.canLogIn
      opacity: enabled ? 1 : 0.45
      selected: true
      text: root.health === "not-set-up" ? "Connect mail" : "Sign in again"
      fontSize: Style.font.bodySmall
      onClicked: root.store.login("mail")
    }
    // Before the code arrives (starting the server, first use installs it).
    Button {
      visible: root.loggingIn && !root.showsCode && root.phase !== "syncing"
      bordered: true; text: "Cancel"; fontSize: Style.font.bodySmall
      onClicked: root.store.cancelLogin()
    }
    Button {
      visible: !root.loggingIn && root.health === "source-down"
      enabled: !!root.store && !root.store.refreshing
      opacity: enabled ? 1 : 0.45
      bordered: true; text: enabled ? "Retry now" : "Retrying…"; fontSize: Style.font.bodySmall
      onClicked: root.store.retry("mail")
    }
    Button {
      visible: !root.loggingIn && root.connected && !root.confirming
      enabled: !!root.store && !root.store.removalRuns
      opacity: enabled ? 1 : 0.45
      bordered: true; text: "Disconnect"; fontSize: Style.font.bodySmall
      onClicked: root.store.askRemove("mail")
    }
  }

  RemoveConfirm {
    width: root.width
    store: root.store; fg: root.fg; ff: root.ff
    connectionKey: "mail"
    action: "Disconnect"
    question: "Disconnect Microsoft 365 mail? This signs the tracker out of your mailbox and removes the Orders only mail found."
  }

  // Only one Login at a time: say which one to finish first.
  Text {
    visible: !!root.login && !root.loggingIn && (root.health === "not-set-up" || root.health === "needs-login")
    width: root.width
    wrapMode: Text.WordWrap
    text: root.store ? root.store.loginBlockedText : ""
    color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
  }
}
