// PROTOTYPE #18 variant B: a separate "Sources" page inside the popup.
// No wizard: the popup has two pages, Shipments and Sources. First run shows
// the Shipment list's empty state with a "Connect Sources" button; the gear
// opens the same page later. Each Source is one accordion row that expands in
// place. A banner's "Log in" fixes the Source right in the banner, without
// leaving the list.
import QtQuick
import qs.Commons
import qs.Ui

Column {
  id: root
  property var host: null
  readonly property bool editing: (listView.item && listView.item.editing === true) || (sourcesView.item && sourcesView.item.editing === true)
  readonly property color fg: host ? host.fg : Color.foreground
  readonly property string ff: host ? host.fontFamily : Style.font.family
  readonly property bool onSources: host && host.page.indexOf("sources") === 0
  function scrollToEnd() { if (listView.item) listView.item.scrollToEnd() }

  Loader {
    id: listView
    width: parent.width
    active: !root.onSources
    visible: active
    sourceComponent: ShipmentList {
      host: root.host
      showGear: true
      gearTip: "Sources"
      onGearClicked: root.host.page = "sources"
      emptyTitle: root.host && !root.host.anySource ? "Nothing tracked yet" : "No Shipments in the last " + (root.host ? root.host.days : 7) + " days"
      emptyText: root.host && !root.host.anySource ? "Paste a tracking number or Amazon order ID below, or connect DHL and Amazon to find your Shipments automatically." : ""
      emptyActionText: root.host && !root.host.anySource ? "Connect Sources" : ""
      onEmptyAction: root.host.page = "sources"
      // Fix-later path: the banner itself runs the login, the list stays.
      onBannerAction: function(src) {
        if (src.state === "needs-login") root.host.login(src.key)
        else if (src.state === "source-down") root.host.refresh()
        else if (src.state === "code") Qt.openUrlExternally(root.host.deviceUrl)
        else root.host.cancel(src.key)
      }
    }
  }

  Loader {
    id: sourcesView
    width: parent.width
    active: root.onSources
    visible: active
    sourceComponent: Column {
      id: page
      width: root.width
      spacing: Style.space(6)
      readonly property bool editing: rowRepeater.editingAny
      // Which row is open. Default: the first Source that isn't set up yet.
      readonly property string openKey: {
        var p = root.host.page
        if (p.indexOf("sources:") === 0) {
          var k = p.substring(8)
          if (k === "none") return ""
          return (k === "dhl" || k === "amazon" || k === "mail") ? k : "amazon"
        }
        if (root.host.dhl.state === "none") return "dhl"
        if (root.host.accounts.length === 0) return "amazon"
        if (root.host.mail.state === "none") return "mail"
        return ""
      }

      // Header
      Item {
        width: parent.width
        height: Math.max(backBtn.implicitHeight, hdr.implicitHeight)
        PanelActionButton { id: backBtn; anchors.verticalCenter: parent.verticalCenter; iconText: "\u{F004D}"; tooltipText: "Back to Shipments"; foreground: root.fg; onClicked: root.host.page = "list" }
        Column {
          id: hdr
          anchors.left: backBtn.right; anchors.leftMargin: Style.space(8); anchors.verticalCenter: parent.verticalCenter
          Text { text: "Sources"; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.heading; font.bold: true }
          Text { text: "Where Shipments are found · all optional"; color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption }
        }
      }

      Repeater {
        id: rowRepeater
        property bool editingAny: false
        model: [
          { key: "dhl", glyph: "\u{F053D}", name: "DHL", sub: "dhl.de account" },
          { key: "amazon", glyph: "\u{F0110}", name: "Amazon", sub: "one entry per account" },
          { key: "mail", glyph: "\u{F01F0}", name: "Microsoft 365 mail", sub: "optional · Amazon Orders from mail" }
        ]
        delegate: Rectangle {
          id: row
          required property var modelData
          readonly property bool open: page.openKey === modelData.key
          readonly property string summary: {
            var h = root.host
            if (modelData.key === "amazon") {
              if (h.accounts.length === 0) return "Not connected"
              var bad = h.accounts.filter(function(a) { return a.state !== "ok" }).length
              return h.accounts.map(function(a) { return a.label }).join(", ") + (bad ? " · " + bad + " need" + (bad === 1 ? "s" : "") + " you" : "")
            }
            var s = modelData.key === "dhl" ? h.dhl.state : h.mail.state
            return s === "none" ? "Not connected" : s === "ok" ? "Connected" : s === "needs-login" ? "Needs a login" : s === "source-down" ? "Can't be read" : "Connecting…"
          }
          readonly property bool bad: summary.indexOf("need") >= 0 || summary === "Needs a login" || summary === "Can't be read"
          readonly property bool good: summary === "Connected" || (modelData.key === "amazon" && root.host.accounts.length > 0 && !bad)
          width: page.width
          height: rowCol.implicitHeight + Style.space(12)
          radius: Style.cornerRadius
          color: open ? Style.normalFillFor(root.fg, Color.accent, Color.urgent) : "transparent"
          border.color: open ? Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.2) : "transparent"; border.width: 1
          Column {
            id: rowCol
            x: Style.space(8); y: Style.space(6); width: parent.width - Style.space(16)
            spacing: Style.space(8)
            Item {
              width: parent.width; height: Style.space(34)
              Text { id: g; anchors.verticalCenter: parent.verticalCenter; width: Style.space(24); text: row.modelData.glyph; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.iconLarge }
              Column {
                anchors.left: g.right; anchors.leftMargin: Style.space(8); anchors.verticalCenter: parent.verticalCenter
                Text { text: row.modelData.name; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body; font.bold: true }
                Text { text: row.modelData.sub; color: Qt.darker(root.fg, 1.6); font.family: root.ff; font.pixelSize: Style.font.caption }
              }
              Row {
                anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(6)
                Text { anchors.verticalCenter: parent.verticalCenter; text: row.summary; color: row.bad ? Color.urgent : row.good ? Color.accent : Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.bodySmall }
                Text { anchors.verticalCenter: parent.verticalCenter; text: row.open ? "\u{F0140}" : "\u{F0142}"; color: Qt.darker(root.fg, 1.4); font.family: root.ff; font.pixelSize: Style.font.icon }
              }
              MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.host.page = row.open ? "sources:none" : "sources:" + row.modelData.key }
            }
            SourceSetup {
              visible: row.open
              width: parent.width
              host: root.host
              which: row.modelData.key
              onEditingChanged: rowRepeater.editingAny = editing
            }
          }
        }
      }

      PanelSeparator { foreground: root.fg }
      SourceSetup { width: parent.width; host: root.host; which: "notify" }
      Button { anchors.right: parent.right; selected: true; text: "Done"; onClicked: root.host.page = "list" }
    }
  }
}
