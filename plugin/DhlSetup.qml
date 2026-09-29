// The DHL row's setup (#18 §3): what it does, its state, and Log in to DHL.
// The Login runs `login dhl` as a transient unit (Store.login); the row shows
// its progress with Cancel. Disconnect asks inline first (#32).
import QtQuick
import qs.Commons
import qs.Ui

Column {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  readonly property var connection: store ? store.connection("dhl") : null
  readonly property string health: connection && connection.health ? connection.health : "not-set-up"
  readonly property var login: store ? store.activeLogin : null
  readonly property bool loggingIn: !!login && login.key === "dhl"
  readonly property bool syncing: loggingIn && !!login.connection && !!login.connection.login && login.connection.login.phase === "syncing"
  readonly property bool canLogIn: !!store && !login && store.nodeOk !== false
  readonly property bool connected: health === "ok" || health === "needs-login" || health === "source-down"
  readonly property bool confirming: !!store && (store.confirmingRemoval === "dhl" || store.removingKey === "dhl")
  spacing: Style.space(8)

  NodeNotice { width: root.width; store: root.store; fg: root.fg; ff: root.ff }

  Text {
    width: root.width
    wrapMode: Text.WordWrap
    text: "Finds every DHL parcel on your dhl.de account, Incoming and Outgoing. You log in once in a separate Chrome window; after that it refreshes hourly without a browser."
    color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.bodySmall
  }

  ConnectionLine { width: root.width; store: root.store; fg: root.fg; ff: root.ff; connectionKey: "dhl" }

  Row {
    spacing: Style.space(6)
    Button {
      visible: !root.loggingIn && (root.health === "not-set-up" || root.health === "needs-login")
      enabled: root.canLogIn
      opacity: enabled ? 1 : 0.45
      selected: true
      text: root.health === "not-set-up" ? "Log in to DHL" : "Log in again"
      fontSize: Style.font.bodySmall
      onClicked: root.store.login("dhl")
    }
    Button {
      visible: root.loggingIn && !root.syncing
      bordered: true; text: "Cancel"; fontSize: Style.font.bodySmall
      onClicked: root.store.cancelLogin()
    }
    Button {
      visible: !root.loggingIn && root.health === "source-down"
      enabled: !!root.store && !root.store.refreshing
      opacity: enabled ? 1 : 0.45
      bordered: true; text: enabled ? "Retry now" : "Retrying…"; fontSize: Style.font.bodySmall
      onClicked: root.store.retry("dhl")
    }
    Button {
      visible: !root.loggingIn && root.connected && !root.confirming
      enabled: !!root.store && !root.store.removalRuns
      opacity: enabled ? 1 : 0.45
      bordered: true; text: "Disconnect"; fontSize: Style.font.bodySmall
      onClicked: root.store.askRemove("dhl")
    }
  }

  RemoveConfirm {
    width: root.width
    store: root.store; fg: root.fg; ff: root.ff
    connectionKey: "dhl"
    action: "Disconnect"
    question: "Disconnect DHL? This deletes its Chrome login profile and sign-in."
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
