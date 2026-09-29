// PROTOTYPE variant B: hero sentence + sections by what the user must do (#9).
// "Needs you" (Ready for pickup, Problem, Sources needing login) / "Today"
// (Out for delivery) / "On the way" (everything else in flight), then Terminal
// Shipments collapsed into one "Done" line that expands. Footer: icon buttons;
// the add button reveals the manual-add field inline.
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
  property bool doneOpen: false
  property bool addOpen: false

  readonly property var all: host ? host.shipments : []
  readonly property var needsYou: all.filter(function(s) { return Fake.attention[s.status] })
  readonly property var today: all.filter(function(s) { return s.status === "Out for delivery" })
  readonly property var onTheWay: all.filter(function(s) { return !Fake.attention[s.status] && !Fake.terminal[s.status] && s.status !== "Out for delivery" })
  readonly property var done: all.filter(function(s) { return Fake.terminal[s.status] })
  readonly property var troubled: host ? host.troubled : []
  readonly property int rowHeight: Style.space(30)

  function hero() {
    var parts = []
    var n = needsYou.length + troubled.length
    if (n > 0) parts.push(n + " need" + (n === 1 ? "s" : "") + " you")
    if (today.length > 0) parts.push(today.length + " arriving today")
    if (onTheWay.length > 0) parts.push(onTheWay.length + " on the way")
    return parts.length ? parts.join(", ") + "." : "Nothing on the way."
  }
  function doneSummary() {
    var delivered = done.filter(function(s) { return s.status === "Delivered" }).length
    var returned = done.length - delivered
    return delivered + " delivered" + (returned ? ", " + returned + " returned" : "") + " in the last " + (host ? host.days : 7) + " days"
  }

  spacing: Style.space(10)
  function scrollToEnd() { scroller.contentY = Math.max(0, scroller.contentHeight - scroller.height) }

  // ---- Hero
  Column {
    width: parent.width
    spacing: Style.space(2)
    Text { width: parent.width; wrapMode: Text.WordWrap; text: root.hero(); color: root.fg; font.family: root.ff; font.pixelSize: Style.font.heading; font.bold: true }
    Text {
      text: root.host ? (root.host.refreshing ? "Refreshing…" : "Updated " + Fake.age(root.host.lastRefresh)) : ""
      color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
    }
  }

  // ---- Sections, scrollable when long
  Flickable {
    id: scroller
    width: parent.width
    height: Math.min(sections.implicitHeight, Style.space(300))
    contentWidth: width
    contentHeight: sections.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: sections
      width: scroller.width
      spacing: Style.space(4)

      PanelSectionHeader { visible: root.needsYou.length + root.troubled.length > 0; text: "NEEDS YOU"; foreground: root.fg }
      Repeater {
        model: root.troubled
        delegate: Item {
          required property var modelData
          width: sections.width
          height: root.rowHeight
          Text { id: lockGlyph; x: Style.space(4); width: Style.space(22); anchors.verticalCenter: parent.verticalCenter; text: "\u{F033E}"; color: Color.urgent; font.family: root.ff; font.pixelSize: Style.font.icon }
          Text {
            anchors.left: lockGlyph.right; anchors.verticalCenter: parent.verticalCenter
            text: modelData.source + (modelData.account ? " · " + modelData.account : "") + " is signed out"
            color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body
          }
          Button { anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; text: "Log in"; bordered: true; fontSize: Style.font.bodySmall; verticalPadding: Style.space(2); onClicked: root.host.openUrl(modelData.loginUrl) }
        }
      }
      Repeater { model: root.needsYou; delegate: rowComponent }

      PanelSectionHeader { visible: root.today.length > 0; text: "TODAY"; foreground: root.fg; topPadding: Style.space(6) }
      Repeater { model: root.today; delegate: rowComponent }

      PanelSectionHeader { visible: root.onTheWay.length > 0; text: "ON THE WAY"; foreground: root.fg; topPadding: Style.space(6) }
      Repeater { model: root.onTheWay; delegate: rowComponent }

      // Done: one collapsed line; expands to the Terminal rows.
      Item {
        visible: root.done.length > 0
        width: sections.width
        height: root.rowHeight
        Text {
          anchors.verticalCenter: parent.verticalCenter
          x: Style.space(4)
          text: (root.doneOpen ? "\u{F0140}  " : "\u{F0142}  ") + root.doneSummary()
          color: Qt.darker(root.fg, 1.4); font.family: root.ff; font.pixelSize: Style.font.bodySmall
        }
        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.doneOpen = !root.doneOpen }
      }
      Repeater { model: root.doneOpen ? root.done : []; delegate: rowComponent }
    }
  }

  // ---- Inline manual add, revealed by the + button
  Row {
    visible: root.addOpen
    width: parent.width
    spacing: Style.space(6)
    TextField {
      id: addField
      width: parent.width - Style.space(60)
      placeholderText: "Tracking number or Amazon order ID"
      foreground: root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall
      onAccepted: { if (root.host.addManual(text)) { text = ""; root.addOpen = false } }
      Keys.onEscapePressed: { root.addOpen = false; focus = false }
    }
    Button { text: "Add"; bordered: true; onClicked: { if (root.host.addManual(addField.text)) { addField.text = ""; root.addOpen = false } } }
  }

  PanelSeparator { foreground: root.fg }

  // ---- Footer: icon buttons only
  Item {
    width: parent.width
    height: footerLeft.implicitHeight
    Row {
      id: footerLeft
      spacing: Style.space(4)
      PanelActionButton { iconText: "\u{F0415}"; tooltipText: "Add a Shipment"; foreground: root.fg
        onClicked: { root.addOpen = !root.addOpen; if (root.addOpen) Qt.callLater(function() { addField.forceActiveFocus() }) } }
      PanelActionButton { iconText: "\u{F0450}"; tooltipText: "Refresh now"; foreground: root.fg; onClicked: root.host.refresh() }
      PanelActionButton { iconText: root.host && root.host.notificationsOn ? "\u{F009A}" : "\u{F009B}"; tooltipText: root.host && root.host.notificationsOn ? "Notifications on" : "Notifications off"; foreground: root.fg; onClicked: root.host.toggleNotifications() }
    }
    Button {
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      text: root.host && root.host.days === 30 ? "Last 30 days" : "Last 7 days"
      fontSize: Style.font.bodySmall
      tooltipText: "Switch 7 / 30 days"
      onClicked: root.host.days = root.host.days === 30 ? 7 : 30
    }
  }

  Component {
    id: rowComponent
    Rectangle {
      id: row
      required property var modelData
      readonly property var s: modelData
      readonly property bool pickup: s.status === "Ready for pickup"
      readonly property bool problem: s.status === "Problem"
      width: sections.width
      height: root.rowHeight
      radius: Style.cornerRadius
      color: mouse.containsMouse ? Style.hoverFillFor(root.fg, Color.accent) : "transparent"
      opacity: Fake.terminal[s.status] ? 0.55 : 1

      Text {
        id: g
        x: Style.space(4); width: Style.space(22)
        anchors.verticalCenter: parent.verticalCenter
        text: Fake.statusGlyph(row.s.status)
        color: row.problem ? Color.urgent : row.pickup ? Color.accent : root.fg
        font.family: root.ff; font.pixelSize: Style.font.icon
      }
      Text {
        id: dir
        anchors.left: g.right; anchors.verticalCenter: parent.verticalCenter
        width: Style.space(16)
        text: row.s.direction === "Outgoing" ? "\u{F005D}" : ""
        color: Qt.darker(root.fg, 1.4); font.family: root.ff; font.pixelSize: Style.font.bodySmall
      }
      Text {
        id: t
        anchors.left: dir.right; anchors.verticalCenter: parent.verticalCenter
        width: Math.min(implicitWidth, parent.width - x - est.implicitWidth - Style.space(12))
        elide: Text.ElideRight
        text: row.s.title
        color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body; font.bold: row.pickup || row.problem
      }
      Text {
        anchors.left: t.right; anchors.leftMargin: Style.space(6); anchors.verticalCenter: parent.verticalCenter
        text: row.s.source === "Amazon" ? row.s.account : ""
        color: Qt.darker(root.fg, 1.6); font.family: root.ff; font.pixelSize: Style.font.caption
      }
      Text {
        id: est
        anchors.right: parent.right; anchors.rightMargin: Style.space(6); anchors.verticalCenter: parent.verticalCenter
        text: (row.s.delayed ? "Delayed · " : "") + (row.problem || row.pickup || Fake.terminal[row.s.status] ? row.s.estimate : (row.s.estimate || row.s.status))
        color: row.s.delayed || row.problem ? Color.urgent : row.pickup ? Color.accent : Qt.darker(root.fg, 1.2)
        font.family: root.ff; font.pixelSize: Style.font.bodySmall
      }
      MouseArea { id: mouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.host.openUrl(row.s.url) }
    }
  }
}
