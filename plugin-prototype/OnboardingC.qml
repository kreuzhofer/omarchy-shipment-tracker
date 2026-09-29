// PROTOTYPE #18 variant C: progressive setup cards inside the Shipment list.
// There is no setup screen at all. The list is always shown (empty at first,
// manual add works), and one setup card at a time sits above it: DHL, then
// Amazon, then mail, then notifications. "Not now" puts a card off. A chip row
// above the footer shows every Source's health; clicking a chip re-opens that
// Source's card to log in again, add an account or remove it.
import QtQuick
import qs.Commons
import qs.Ui

Column {
  id: root
  property var host: null
  readonly property bool editing: listItem.editing === true
  readonly property color fg: host ? host.fg : Color.foreground
  readonly property string ff: host ? host.fontFamily : Style.font.family
  function scrollToEnd() { listItem.scrollToEnd() }

  readonly property var order: ["dhl", "amazon", "mail", "notify"]
  function pendingSetup(key) {
    var h = host
    if (!h || h.dismissed[key]) return false
    if (key === "dhl") return ["none", "connecting", "syncing"].indexOf(h.dhl.state) >= 0
    if (key === "mail") return ["none", "code", "syncing"].indexOf(h.mail.state) >= 0
    return true // amazon (multi-account) and notify wait for an explicit "Done"
  }
  // The card on screen: the one the user asked for (chip / banner / IPC),
  // else the next Source not yet set up.
  readonly property string card: {
    if (!host) return ""
    if (host.page !== "" && host.page !== "list") return host.page
    for (var i = 0; i < order.length; i++) if (pendingSetup(order[i])) return order[i]
    return ""
  }
  readonly property bool asked: host && host.page !== "" && host.page !== "list"
  readonly property string cardKind: card === "" ? "" : (order.indexOf(card) >= 0 ? card : "amazon")
  function dismiss() {
    if (asked) { host.page = ""; return }
    var d = {}
    for (var k in host.dismissed) d[k] = host.dismissed[k]
    d[card] = true
    host.dismissed = d
  }

  ShipmentList {
    id: listItem
    width: parent.width
    host: root.host
    emptyTitle: root.host && !root.host.anySource ? "Nothing tracked yet" : "No Shipments in the last " + (root.host ? root.host.days : 7) + " days"
    emptyText: root.host && !root.host.anySource ? "Paste a tracking number or Amazon order ID below. Shipments from connected Sources show up here." : ""
    onBannerAction: function(src) {
      if (src.state === "source-down") { root.host.refresh(); return }
      if (src.state === "needs-login") root.host.login(src.key)
      root.host.page = src.key.indexOf("amazon:") === 0 ? src.key.substring(7) : src.key
    }

    topComponent: root.card === "" ? null : cardComponent
    bottomComponent: chipsComponent
  }

  Component {
    id: cardComponent
    Rectangle {
      readonly property bool editing: setup.editing
      width: listItem.width
      height: cardCol.implicitHeight + Style.space(20)
      radius: Style.cornerRadius
      color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.08)
      border.color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.6); border.width: 1
      Column {
        id: cardCol
        x: Style.space(10); y: Style.space(10); width: parent.width - Style.space(20)
        spacing: Style.space(8)
        Item {
          width: parent.width; height: Math.max(cardTitle.implicitHeight, notNow.implicitHeight)
          Row {
            id: cardTitle
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(8)
            Text { text: root.cardKind === "dhl" ? "\u{F053D}" : root.cardKind === "amazon" ? "\u{F0110}" : root.cardKind === "mail" ? "\u{F01F0}" : "\u{F009A}"
              color: Color.accent; font.family: root.ff; font.pixelSize: Style.font.iconLarge }
            Column {
              anchors.verticalCenter: parent.verticalCenter
              Text { text: root.cardKind === "dhl" ? "Find your DHL parcels" : root.cardKind === "amazon" ? (root.asked && root.card !== "amazon" ? "Amazon · " + root.card : "Find your Amazon orders") : root.cardKind === "mail" ? "Also read delivery mails?" : "Get notified?"
                color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body; font.bold: true }
              Text { visible: !root.asked; text: "Setup " + (root.order.indexOf(root.card) + 1) + " of 4 · optional"; color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption }
            }
          }
          Button {
            id: notNow
            anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
            bordered: true; fontSize: Style.font.bodySmall
            text: root.asked ? "Close" : (root.cardKind === "amazon" && root.host.accounts.length > 0) || root.cardKind === "notify" ? "Done" : "Not now"
            onClicked: root.dismiss()
          }
        }
        SourceSetup { id: setup; width: parent.width; host: root.host; which: root.cardKind; showIntro: !root.asked }
      }
    }
  }

  Component {
    id: chipsComponent
    Flow {
      width: listItem.width
      spacing: Style.space(6)
      Text { text: "Sources"; color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption; height: Style.space(24); verticalAlignment: Text.AlignVCenter }
      Repeater {
        model: {
          var h = root.host
          var out = []
          // Connected Sources first, then "+ …" chips for what can still be added.
          if (h.dhl.state !== "none") out.push({ page: "dhl", name: "DHL", state: h.dhl.state })
          h.accounts.forEach(function(a) { out.push({ page: a.label, name: a.label, state: a.state }) })
          if (h.mail.state !== "none") out.push({ page: "mail", name: "Mail", state: h.mail.state })
          if (h.dhl.state === "none") out.push({ page: "dhl", name: "+ DHL", state: "add" })
          out.push({ page: "amazon", name: "+ Amazon", state: "add", addAccount: h.accounts.length > 0 })
          if (h.mail.state === "none") out.push({ page: "mail", name: "+ Mail", state: "add" })
          return out
        }
        delegate: Rectangle {
          required property var modelData
          readonly property bool bad: modelData.state === "needs-login" || modelData.state === "source-down"
          width: chipRow.implicitWidth + Style.space(14); height: Style.space(24)
          radius: height / 2
          color: bad ? Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.18) : chipMouse.containsMouse ? Style.hoverFillFor(root.fg, Color.accent) : "transparent"
          border.color: bad ? Color.urgent : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.3); border.width: 1
          Row {
            id: chipRow
            anchors.centerIn: parent
            spacing: Style.space(5)
            Rectangle { visible: modelData.state !== "add"; width: Style.space(7); height: width; radius: width / 2; anchors.verticalCenter: parent.verticalCenter
              color: parent.parent.bad ? Color.urgent : modelData.state === "ok" ? Color.accent : Qt.darker(root.fg, 1.8) }
            Text { text: modelData.name; color: modelData.state === "add" ? Qt.darker(root.fg, 1.5) : root.fg; font.family: root.ff; font.pixelSize: Style.font.caption }
          }
          MouseArea { id: chipMouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { if (modelData.addAccount) root.host.addingAccount = true; root.host.page = modelData.page } }
        }
      }
    }
  }
}
