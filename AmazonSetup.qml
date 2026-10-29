// The Amazon row's setup (#18 §4): the accounts, then the add form. The form
// is open while there's no account, else behind "+ Add another Amazon
// account". Adding runs `accounts add <label> --accept-risk` with the risk
// accepted for that account only (#14), then its Login.
import QtQuick
import qs.Commons
import qs.Ui
import "Shipments.js" as Shipments

Column {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  readonly property color muted: Qt.darker(fg, 1.5)
  readonly property bool editing: labelField.activeFocus
  readonly property var accounts: store ? store.amazonAccounts : []
  readonly property var login: store ? store.activeLogin : null
  readonly property bool formOpen: !!store && (accounts.length === 0 || store.addingAccount)
  spacing: Style.space(8)

  NodeNotice { width: root.width; store: root.store; fg: root.fg; ff: root.ff }

  Text {
    width: root.width
    wrapMode: Text.WordWrap
    text: "Reads the order history of each Amazon account in its own Chrome profile, hourly between 07:00 and 23:00. Add one entry per account, e.g. a personal and a business account."
    color: root.muted; font.family: root.ff; font.pixelSize: Style.font.bodySmall
  }

  // ---- One card per account
  Repeater {
    model: root.accounts
    delegate: Rectangle {
      id: account
      required property var modelData
      readonly property string key: modelData.key
      readonly property var c: modelData.connection
      readonly property string health: c && c.health ? c.health : "not-set-up"
      readonly property bool loggingIn: !!root.login && root.login.key === key
      readonly property bool syncing: loggingIn && !!root.login.connection && !!root.login.connection.login
        && root.login.connection.login.phase === "syncing"
      readonly property string line: !root.store ? ""
        : loggingIn ? Shipments.rowLoginText(key, root.login.connection, root.store.nowMs)
        : Shipments.rowHealthText(key, c, root.store.nowMs) || (health === "not-set-up" ? "Not signed in yet" : "")
      readonly property string tone: Shipments.connectionTone(c, loggingIn)
      readonly property bool confirming: !!root.store && (root.store.confirmingRemoval === key || root.store.removingKey === key)
      width: root.width
      height: accountColumn.implicitHeight + Style.space(12)
      radius: Style.cornerRadius
      color: Style.normalFillFor(root.fg, Color.accent, Color.urgent)

      Column {
        id: accountColumn
        x: Style.space(10)
        width: parent.width - Style.space(20)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(4)
        Item {
          width: parent.width
          height: Math.max(accountName.implicitHeight, accountButtons.implicitHeight)
          Text {
            id: accountGlyph
            anchors.verticalCenter: parent.verticalCenter
            text: Shipments.connectionGlyph(account.c, account.loggingIn)
            color: account.tone === "bad" ? Color.urgent : account.tone === "" ? root.fg : Color.accent
            font.family: root.ff; font.pixelSize: Style.font.icon
          }
          Text {
            id: accountName
            anchors.left: accountGlyph.right
            anchors.leftMargin: Style.space(8)
            anchors.right: accountButtons.left
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            elide: Text.ElideRight
            text: Shipments.connectionName(account.key, account.c)
            color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body; font.bold: true
          }
          Row {
            id: accountButtons
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(4)
            Button {
              visible: !account.loggingIn && (account.health === "not-set-up" || account.health === "needs-login")
              enabled: !!root.store && !root.login && root.store.nodeOk !== false
              opacity: enabled ? 1 : 0.45
              selected: true
              text: account.health === "not-set-up" ? "Sign in" : Shipments.bannerAction(account.c)
              fontSize: Style.font.bodySmall
              onClicked: root.store.login(account.key)
            }
            Button {
              visible: account.loggingIn && !account.syncing
              bordered: true; text: "Cancel"; fontSize: Style.font.bodySmall
              onClicked: root.store.cancelLogin()
            }
            Button {
              visible: !account.loggingIn && account.health === "source-down"
              enabled: !!root.store && !root.store.refreshing
              opacity: enabled ? 1 : 0.45
              bordered: true; text: "Retry"; fontSize: Style.font.bodySmall
              onClicked: root.store.retry(account.key)
            }
            PanelActionButton {
              visible: !account.loggingIn && !account.confirming
              enabled: !!root.store && !root.store.removalRuns
              opacity: enabled ? 1 : 0.45
              iconText: "\u{F0A7A}" // trash can
              tooltipText: "Remove this account and its Chrome profile"
              foreground: root.fg
              hoverColor: Color.urgent
              onClicked: root.store.askRemove(account.key)
            }
          }
        }
        Text {
          visible: account.line !== ""
          width: parent.width
          wrapMode: Text.WordWrap
          text: account.line
          color: root.muted; font.family: root.ff; font.pixelSize: Style.font.caption
        }
        // No password manager in the login profile yet (#51).
        Text {
          visible: !account.loggingIn && (account.health === "not-set-up" || account.health === "needs-login") && !(account.c && account.c.hasExtensions)
          width: parent.width
          wrapMode: Text.WordWrap
          text: "Tip: install your password manager once in the login window; it stays there for later logins."
          color: root.muted; font.family: root.ff; font.pixelSize: Style.font.caption
        }
        Text {
          visible: !!root.login && !account.loggingIn && (account.health === "not-set-up" || account.health === "needs-login")
          width: parent.width
          wrapMode: Text.WordWrap
          text: root.store ? root.store.loginBlockedText : ""
          color: root.muted; font.family: root.ff; font.pixelSize: Style.font.caption
        }
        RemoveConfirm {
          width: parent.width
          store: root.store; fg: root.fg; ff: root.ff
          connectionKey: account.key
          question: "Remove " + Shipments.connectionName(account.key, account.c) + "? This deletes its Chrome profile and sign-in."
        }
      }
    }
  }

  Button {
    visible: !root.formOpen
    bordered: true; iconText: "\u{F0415}"; text: "Add another Amazon account"; fontSize: Style.font.bodySmall
    onClicked: root.store.addingAccount = true
  }

  // ---- The add form
  Column {
    visible: root.formOpen
    width: root.width
    spacing: Style.space(8)

    // The Conditions-of-Use disclosure: not collapsible. The opt-in is per
    // account: a business account may not be the user's own to risk (#14).
    Rectangle {
      width: root.width
      height: riskColumn.implicitHeight + Style.space(16)
      radius: Style.cornerRadius
      color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.10)
      border.color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.7)
      border.width: 1
      Column {
        id: riskColumn
        x: Style.space(10)
        width: parent.width - Style.space(20)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(6)
        Row {
          spacing: Style.space(6)
          Text { text: "\u{F0026}"; color: Color.urgent; font.family: root.ff; font.pixelSize: Style.font.icon }
          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: "Amazon doesn't allow this"
            color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body; font.bold: true
          }
        }
        Text {
          width: parent.width
          wrapMode: Text.WordWrap
          text: "amazon.de's Conditions of Use forbid robots and data-mining tools. The tracker reads this account's orders the way you would, in a real Chrome window, but Amazon may still ask for captchas or restrict the account. Only connect an account you accept that risk for."
          color: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
        }
        Toggle {
          width: parent.width
          label: "I accept this risk for this account"
          checked: !!root.store && root.store.draftRisk
          foreground: root.fg; fontFamily: root.ff; titleSize: Style.font.bodySmall
          onClicked: root.store.draftRisk = !root.store.draftRisk
        }
      }
    }

    TextField {
      id: labelField
      width: root.width
      placeholderText: "Label, e.g. Personal or Business"
      text: root.store ? root.store.draftLabel : ""
      onTextChanged: if (root.store && root.store.draftLabel !== text) root.store.draftLabel = text
      foreground: root.fg
      font.family: root.ff
      font.pixelSize: Style.font.bodySmall
      onAccepted: root.store.addAccount()
      Keys.onEscapePressed: focus = false
    }
    // A label is required and unique; say why only once something is typed.
    Text {
      readonly property string problem: root.store ? root.store.draftProblem : ""
      visible: problem !== "" && problem !== "required"
      width: root.width
      wrapMode: Text.WordWrap
      text: problem
      color: Color.urgent; font.family: root.ff; font.pixelSize: Style.font.caption
    }

    Text {
      width: root.width
      wrapMode: Text.WordWrap
      text: "A Chrome window opens on amazon.de. Sign in and tick “Angemeldet bleiben” so the login lasts. That window becomes the tracker's own profile and can buy with 1-Click, so don't shop in it."
      color: root.muted; font.family: root.ff; font.pixelSize: Style.font.bodySmall
    }

    Row {
      spacing: Style.space(6)
      Button {
        enabled: !!root.store && root.store.canAddAccount
        opacity: enabled ? 1 : 0.45
        selected: true
        text: root.store && root.store.addingAccountRuns ? "Adding…" : "Sign in to Amazon"
        fontSize: Style.font.bodySmall
        onClicked: root.store.addAccount()
      }
      Button {
        visible: root.accounts.length > 0
        bordered: true; text: "Cancel"; fontSize: Style.font.bodySmall
        onClicked: root.store.cancelAddAccount()
      }
    }
    Text {
      visible: !!root.store && (root.store.accountError !== "" || !!root.login)
      width: root.width
      wrapMode: Text.WordWrap
      text: !root.store ? "" : root.store.accountError !== "" ? root.store.accountError : root.store.loginBlockedText
      color: root.store && root.store.accountError !== "" ? Color.urgent : root.muted
      font.family: root.ff; font.pixelSize: Style.font.caption
    }
  }
}
