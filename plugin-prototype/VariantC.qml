// PROTOTYPE variant C: Incoming / Outgoing tabs with counts, one card per
// Shipment with a 5-step progress bar and a Carrier badge (#9). Ready for
// pickup and Problem cards get a coloured border; Terminal cards are dimmed.
// A signed-out Source is a card at the top of the tab it affects.
import QtQuick
import qs.Commons
import qs.Ui
import "FakeData.js" as Fake

Column {
  id: root
  property var host: null
  readonly property bool editing: addField.activeFocus
  readonly property color fg: host ? host.fg : Color.foreground
  readonly property string ff: host ? host.fontFamily : Style.font.family
  property string tab: "Incoming"
  readonly property var all: host ? host.shipments : []
  readonly property var incoming: all.filter(function(s) { return s.direction === "Incoming" })
  readonly property var outgoing: all.filter(function(s) { return s.direction === "Outgoing" })
  readonly property var current: tab === "Incoming" ? incoming : outgoing
  // Amazon is Incoming only, so a signed-out Amazon account belongs on that tab.
  readonly property var troubled: host ? host.troubled.filter(function(s) { return root.tab === "Incoming" || s.source === "DHL" }) : []
  readonly property int cardHeight: Style.space(66)
  readonly property var steps: ["Announced", "In transit", "Hub", "Out for delivery", "Delivered"]

  spacing: Style.space(10)
  function scrollToEnd() { scroller.contentY = Math.max(0, scroller.contentHeight - scroller.height) }

  // ---- Tabs + controls
  Item {
    width: parent.width
    height: tabs.implicitHeight
    Row {
      id: tabs
      spacing: Style.space(4)
      Button { text: "\u{F0045} Incoming " + root.incoming.length; selected: root.tab === "Incoming"; onClicked: root.tab = "Incoming" }
      Button { text: "\u{F005D} Outgoing " + root.outgoing.length; selected: root.tab === "Outgoing"; onClicked: root.tab = "Outgoing" }
    }
    Row {
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(4)
      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: root.host ? (root.host.refreshing ? "…" : Fake.age(root.host.lastRefresh)) : ""
        color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
      }
      PanelActionButton { iconText: "\u{F0450}"; tooltipText: "Refresh now"; foreground: root.fg; onClicked: root.host.refresh() }
      PanelActionButton { iconText: root.host && root.host.notificationsOn ? "\u{F009A}" : "\u{F009B}"; tooltipText: "Notifications"; foreground: root.fg; onClicked: root.host.toggleNotifications() }
    }
  }

  // ---- Cards
  Flickable {
    id: scroller
    width: parent.width
    height: Math.min(cards.implicitHeight, 4 * (root.cardHeight + cards.spacing))
    contentWidth: width
    contentHeight: cards.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: cards
      width: scroller.width
      spacing: Style.space(6)

      Repeater {
        model: root.troubled
        delegate: Rectangle {
          required property var modelData
          width: cards.width
          height: Style.space(40)
          radius: Style.cornerRadius
          color: "transparent"
          border.color: Color.urgent; border.width: 1
          Text {
            x: Style.space(10); anchors.verticalCenter: parent.verticalCenter
            text: "\u{F033E}  " + modelData.source + (modelData.account ? " · " + modelData.account : "") + ": signed out"
            color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body
          }
          Button { anchors.right: parent.right; anchors.rightMargin: Style.space(6); anchors.verticalCenter: parent.verticalCenter; text: "Log in"; bordered: true; fontSize: Style.font.bodySmall; onClicked: root.host.openUrl(modelData.loginUrl) }
        }
      }

      Repeater {
        model: root.current
        delegate: Rectangle {
          id: card
          required property var modelData
          readonly property var s: modelData
          readonly property bool pickup: s.status === "Ready for pickup"
          readonly property bool problem: s.status === "Problem" || s.status === "Returning"
          readonly property bool isTerminal: Fake.terminal[s.status] === true
          width: cards.width
          height: root.cardHeight
          radius: Style.cornerRadius
          color: mouse.containsMouse ? Style.hoverFillFor(root.fg, Color.accent) : Style.normalFillFor(root.fg, Color.accent)
          border.width: pickup || problem ? 2 : 0
          border.color: problem ? Color.urgent : Color.accent
          opacity: isTerminal ? 0.55 : 1

          Column {
            anchors.fill: parent
            anchors.margins: Style.space(8)
            spacing: Style.space(5)

            Item {
              width: parent.width
              height: title.implicitHeight
              Text {
                id: title
                width: Math.min(implicitWidth, parent.width - badge.width - Style.space(8))
                elide: Text.ElideRight
                text: card.s.title
                color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body; font.bold: true
              }
              Rectangle {
                id: badge
                anchors.right: parent.right
                anchors.verticalCenter: title.verticalCenter
                width: badgeText.implicitWidth + Style.space(10)
                height: badgeText.implicitHeight + Style.space(2)
                radius: Style.cornerRadius
                color: Style.selectedFillFor(root.fg, Color.accent)
                Text { id: badgeText; anchors.centerIn: parent
                  text: card.s.source + (card.s.account ? " " + card.s.account : "") + (card.s.carrier && card.s.carrier.indexOf(card.s.source) !== 0 ? " / " + card.s.carrier : "")
                  color: root.fg; font.family: root.ff; font.pixelSize: Style.font.caption }
              }
            }

            // 5-step progress bar. Off-track Statuses paint the bar urgent.
            Row {
              width: parent.width
              spacing: Style.space(3)
              Repeater {
                model: 5
                delegate: Rectangle {
                  required property int index
                  width: (cards.width - Style.space(16) - 4 * Style.space(3)) / 5
                  height: Style.space(4)
                  radius: height / 2
                  color: index < card.s.step
                    ? (card.problem ? Color.urgent : card.pickup ? Color.accent : root.fg)
                    : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.15)
                }
              }
            }

            Item {
              width: parent.width
              height: statusText.implicitHeight
              Text {
                id: statusText
                text: Fake.statusGlyph(card.s.status) + "  " + card.s.status + (card.s.delayed ? "  ·  Delayed" : "")
                color: card.s.delayed || card.problem ? Color.urgent : card.pickup ? Color.accent : root.fg
                font.family: root.ff; font.pixelSize: Style.font.bodySmall
              }
              Text {
                anchors.right: parent.right
                text: card.s.estimate + "  ·  " + Fake.age(card.s.changed)
                color: Qt.darker(root.fg, 1.4); font.family: root.ff; font.pixelSize: Style.font.caption
              }
            }
          }
          MouseArea { id: mouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.host.openUrl(card.s.url) }
        }
      }
    }
  }

  // ---- Footer: add field + window
  Row {
    width: parent.width
    spacing: Style.space(6)
    TextField {
      id: addField
      width: parent.width - windowButton.width - Style.space(6)
      placeholderText: "\u{F0415} Tracking number or Amazon order ID"
      foreground: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
      onAccepted: { if (root.host.addManual(text)) text = "" }
      Keys.onEscapePressed: focus = false
    }
    Button {
      id: windowButton
      text: root.host && root.host.days === 30 ? "30 d" : "7 d"
      bordered: true
      tooltipText: "Show 7 / 30 days"
      onClicked: root.host.days = root.host.days === 30 ? 7 : 30
    }
  }
}
