// The list page of the popup (layout from the #9 prototype, variant A):
// header with the 7 / 30 days switch and refresh, one banner per troubled
// Connection, one row per Shipment, footer with the manual-add field.
// Row: Status glyph | title + Delayed tag | Estimate; muted line Status ·
// Direction · Source · age. Ready for pickup and Problem rows get a rail;
// Ready for pickup also a tint and the accent Estimate; Terminal rows are dimmed.
// A manual add offers removal on hover.
import QtQuick
import qs.Commons
import qs.Ui
import "Shipments.js" as Shipments

Column {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  // While the add field has focus the panel's list shortcuts are off.
  readonly property bool editing: addField.activeFocus
  readonly property int rowHeight: Style.space(46)
  signal openRequested(string url)
  signal closeRequested()
  spacing: Style.space(8)

  function scrollToEnd() { list.positionViewAtEnd() }

  // ---- Header
  Item {
    width: parent.width
    height: Math.max(titleColumn.implicitHeight, headerButtons.implicitHeight)
    Column {
      id: titleColumn
      anchors.left: parent.left
      anchors.right: headerButtons.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      Text { text: "Shipments"; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.heading; font.bold: true }
      Text {
        width: parent.width
        elide: Text.ElideRight
        text: !root.store ? "" : root.store.summary + (root.store.refreshing ? "Refreshing…"
          : root.store.lastRun === "" ? "Not refreshed yet"
          : root.store.sourcesState.offline ? "Offline · updated " + Shipments.age(root.store.lastOnline, root.store.nowMs)
          : "Updated " + Shipments.age(root.store.lastRun, root.store.nowMs))
        color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
      }
    }
    Row {
      id: headerButtons
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(4)
      Button { text: "7 days"; selected: root.store && root.store.days === 7; fontSize: Style.font.bodySmall; onClicked: root.store.setDays(7) }
      Button { text: "30 days"; selected: root.store && root.store.days === 30; fontSize: Style.font.bodySmall; onClicked: root.store.setDays(30) }
      PanelActionButton {
        id: refreshButton
        anchors.verticalCenter: parent.verticalCenter
        iconText: "\u{F0450}"
        tooltipText: "Refresh now"
        foreground: root.fg
        onClicked: root.store.refresh()
      }
    }
  }

  // ---- One banner per troubled Connection (#9, #19). Above the list, so the
  // empty state keeps it too: an empty list never hides a lost login.
  // needs-login: urgent, lock, Log in (Open for a security check);
  // source-down: muted warning, Retry.
  Repeater {
    model: root.store ? root.store.troubled : []
    delegate: Rectangle {
      id: banner
      required property var modelData
      readonly property var c: modelData.connection
      readonly property bool down: c.health === "source-down"
      readonly property color tone: down ? Qt.darker(root.fg, 1.3) : Color.urgent
      width: root.width
      height: Math.max(bannerText.implicitHeight, bannerButton.implicitHeight) + Style.space(12)
      radius: Style.cornerRadius
      color: Qt.rgba(tone.r, tone.g, tone.b, down ? 0.08 : 0.18)
      border.color: down ? Qt.rgba(tone.r, tone.g, tone.b, 0.45) : tone
      border.width: 1

      Text {
        id: bannerGlyph
        anchors.left: parent.left
        anchors.leftMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        text: banner.down ? "\u{F0026}" : "\u{F033E}" // alert / lock
        color: banner.tone; font.family: root.ff; font.pixelSize: Style.font.icon
      }
      Text {
        id: bannerText
        anchors.left: bannerGlyph.right
        anchors.leftMargin: Style.space(8)
        anchors.right: bannerButton.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        wrapMode: Text.WordWrap
        maximumLineCount: 2
        elide: Text.ElideRight
        text: root.store ? Shipments.bannerText(banner.modelData.key, banner.c, root.store.nowMs) : ""
        color: banner.down ? Qt.darker(root.fg, 1.15) : root.fg
        font.family: root.ff; font.pixelSize: Style.font.bodySmall
      }
      Button {
        id: bannerButton
        anchors.right: parent.right
        anchors.rightMargin: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
        readonly property string actionText: Shipments.bannerAction(banner.c)
        // Retry waits for the run it started.
        enabled: !(actionText === "Retry" && root.store && root.store.refreshing)
        text: enabled ? actionText : "Retrying…"
        bordered: true; fontSize: Style.font.bodySmall
        onClicked: {
          if (actionText === "Retry") root.store.retry(banner.modelData.key)
          else root.store.login(banner.modelData.key)
        }
      }
    }
  }

  // ---- The list: 5 rows visible, scrolls to more.
  ListView {
    id: list
    width: parent.width
    height: Math.min(count, 5) * root.rowHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    model: root.store ? root.store.recentShipments : []

    delegate: Rectangle {
      id: row
      required property var modelData
      readonly property var s: modelData
      readonly property bool isTerminal: Shipments.terminal[s.status] === true
      readonly property bool pickup: s.status === "Ready for pickup"
      readonly property bool problem: s.status === "Problem"
      readonly property bool removable: (s.connections || []).length === 1 && s.connections[0] === "manual"
      property bool removeHovered: false
      readonly property bool hot: rowMouse.containsMouse || removeHovered
      width: list.width
      height: root.rowHeight
      radius: Style.cornerRadius
      color: hot ? Style.hoverFillFor(root.fg, Color.accent)
        : pickup ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.16)
        : "transparent"
      opacity: isTerminal ? 0.55 : 1

      Rectangle { // left rail marks the Shipments that need the user
        visible: row.pickup || row.problem
        width: Style.space(3); height: parent.height - Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        color: row.problem ? Color.urgent : Color.accent
      }

      Text {
        id: glyph
        anchors.left: parent.left
        anchors.leftMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(22)
        text: Shipments.statusGlyph(row.s.status)
        color: row.problem ? Color.urgent : row.pickup ? Color.accent : root.fg
        font.family: root.ff; font.pixelSize: Style.font.iconLarge
      }

      Column {
        anchors.left: glyph.right
        anchors.leftMargin: Style.space(8)
        anchors.right: parent.right
        anchors.rightMargin: Style.space(10) + (removeButton.visible ? removeButton.width + Style.space(4) : 0)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Item {
          width: parent.width
          height: titleText.implicitHeight
          Text {
            id: titleText
            anchors.left: parent.left
            width: Math.min(implicitWidth, parent.width - estimateText.implicitWidth - delayTag.width - Style.space(12))
            elide: Text.ElideRight
            text: row.s.title
            color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body; font.bold: row.pickup || row.problem
          }
          Rectangle {
            id: delayTag
            visible: row.s.delayed === true
            width: visible ? delayText.implicitWidth + Style.space(8) : 0
            height: delayText.implicitHeight + Style.space(2)
            anchors.left: titleText.right; anchors.leftMargin: Style.space(6)
            anchors.verticalCenter: titleText.verticalCenter
            radius: Style.cornerRadius
            color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.25)
            Text { id: delayText; anchors.centerIn: parent; text: "Delayed"; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.caption }
          }
          Text {
            id: estimateText
            anchors.right: parent.right
            text: Shipments.estimateText(row.s, root.store.nowMs)
            color: row.pickup ? Color.accent : root.fg; font.family: root.ff; font.pixelSize: Style.font.bodySmall; font.bold: row.pickup
          }
        }
        Text {
          width: parent.width
          elide: Text.ElideRight
          text: row.s.status + "  ·  " + (row.s.direction === "Outgoing" ? "\u{F005D} Outgoing" : "\u{F0045} Incoming")
            + "  ·  " + Shipments.sourceLabel(row.s) + "  ·  " + Shipments.age(row.s.changedAt, root.store.nowMs)
          color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
        }
      }

      MouseArea {
        id: rowMouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.openRequested(row.s.url)

        // Inside the row's MouseArea so hovering it keeps the row hovered.
        PanelActionButton {
          id: removeButton
          visible: row.removable && row.hot
          anchors.right: parent.right
          anchors.rightMargin: Style.space(6)
          anchors.verticalCenter: parent.verticalCenter
          iconText: "\u{F0156}"
          tooltipText: "Remove"
          foreground: root.fg
          hoverColor: Color.urgent
          onHovered: function(isHovered) { row.removeHovered = isHovered }
          onClicked: root.store.remove(row.s.key)
        }
      }
    }
  }

  // ---- Empty state: first run, or nothing in the 7 / 30 days window.
  Column {
    visible: list.count === 0
    width: parent.width
    spacing: Style.space(6)
    topPadding: Style.space(10)
    bottomPadding: Style.space(6)
    Text { anchors.horizontalCenter: parent.horizontalCenter; text: "\u{F03D7}"; color: Qt.darker(root.fg, 1.8); font.family: root.ff; font.pixelSize: Style.font.display }
    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      text: !root.store || root.store.nothingTracked ? "No Shipments yet" : "No Shipments in the last " + root.store.days + " days"
      color: Qt.darker(root.fg, 1.3); font.family: root.ff; font.pixelSize: Style.font.body
    }
    Button {
      anchors.horizontalCenter: parent.horizontalCenter
      visible: root.store && !root.store.nothingTracked && root.store.days === 7
      text: "Show 30 days"; bordered: true; fontSize: Style.font.bodySmall
      onClicked: root.store.setDays(30)
    }
    Text {
      visible: !root.store || root.store.nothingTracked
      width: parent.width - Style.space(40)
      anchors.horizontalCenter: parent.horizontalCenter
      horizontalAlignment: Text.AlignHCenter
      wrapMode: Text.WordWrap
      text: "Paste a DHL tracking number or an Amazon order ID below to track it."
      color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.bodySmall
    }
  }

  Text {
    width: parent.width
    horizontalAlignment: Text.AlignHCenter
    visible: list.count > 5
    text: list.count + " Shipments · scroll for more"
    color: Qt.darker(root.fg, 1.6); font.family: root.ff; font.pixelSize: Style.font.caption
  }

  PanelSeparator { foreground: root.fg }

  // ---- Footer: manual add + notifications toggle
  Row {
    width: parent.width
    spacing: Style.space(6)
    TextField {
      id: addField
      width: parent.width - addButton.width - bell.width - Style.space(12)
      placeholderText: "Add tracking number or Amazon order ID"
      foreground: root.fg
      font.family: root.ff
      font.pixelSize: Style.font.bodySmall
      onAccepted: { if (root.store.add(text)) text = "" }
      Keys.onEscapePressed: root.closeRequested()
    }
    Button {
      id: addButton
      text: "Add"
      bordered: true
      onClicked: { if (root.store.add(addField.text)) addField.text = "" }
    }
    PanelActionButton {
      id: bell
      anchors.verticalCenter: parent.verticalCenter
      iconText: root.store && root.store.notificationsOn ? "\u{F009A}" : "\u{F009B}"
      tooltipText: root.store && root.store.notificationsOn ? "Notifications on" : "Notifications off"
      foreground: root.fg
      onClicked: root.store.toggleNotifications()
    }
  }

  Text {
    visible: root.store && root.store.addError !== ""
    width: parent.width
    wrapMode: Text.WordWrap
    text: root.store ? root.store.addError : ""
    color: Color.urgent; font.family: root.ff; font.pixelSize: Style.font.caption
  }
}
