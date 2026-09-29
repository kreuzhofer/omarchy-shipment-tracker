// The list page of the popup (#52: variant C of the #9 prototype).
// Header: Incoming / Outgoing tabs with counts and a dot when the tab holds
// something that needs the user; the 7 / 30 days switch, the gear, refresh
// and the notifications bell; the summary line under them.
// One banner per troubled Connection the tab is affected by (Amazon only on
// Incoming), then one card per Shipment of the tab, in urgency order:
// title + Carrier/Source badge | 5-step progress bar | Status + Delayed,
// Estimate · age. Ready for pickup and Problem cards get a coloured border;
// Terminal and Dismissed cards are dimmed. Amazon cards lead with a square
// tile (#58, option A of #54): the item's image, cached by the CLI, or a
// package glyph until there is one; so do DHL cards whose item a mail named.
// An Order only mail knows shows "from mail" in its badge and the last mail's
// hint instead of a Status, over an empty bar (#59). Footer: the manual-add field.
// A manual add offers removal on hover, every card dismissal (#35): the card
// slides out and the cards below close the gap; "N dismissed · show" under
// the list brings Dismissed cards back into view, dimmed, with "Show again".
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
  readonly property int cardHeight: Style.space(66)
  readonly property int cardSpacing: Style.space(6)
  // Incoming is the default; the tab stays while the shell runs.
  property string tab: "Incoming"
  signal openRequested(string url)
  signal closeRequested()
  // The gear and Connect Sources open the Sources page (#31).
  signal sourcesRequested()
  spacing: Style.space(8)

  function scrollToEnd() { list.positionViewAtEnd() }

  // The tab switch (and IPC `tab incoming|outgoing`). The model is swapped
  // out and back, so the other tab's cards appear at once instead of sliding.
  function setTab(name) {
    var t = Shipments.tabName(name)
    if (t === "" || t === root.tab) return
    list.model = null
    root.tab = t
    root.syncRows()
    list.model = rows
    list.forceLayout()
    list.positionViewAtBeginning()
  }

  readonly property var recent: root.store ? root.store.recentShipments : []
  // The tab label's count: pending Shipments only (not Terminal, not Dismissed).
  function countIn(t) { return root.store ? Shipments.pendingCount(t, root.store.recentAll) : 0 }
  // Dismissed Shipments of this tab within the 7 / 30 days window.
  readonly property int tabDismissedCount: root.store
    ? root.store.recentAll.filter(function(s) { return s.dismissed && Shipments.inTab(s, root.tab) }).length : 0

  // ---- Header: tabs and controls
  Item {
    width: parent.width
    height: Math.max(tabRow.implicitHeight, headerButtons.implicitHeight)
    Row {
      id: tabRow
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(4)
      Repeater {
        model: Shipments.tabs
        delegate: Button {
          id: tabButton
          required property string modelData
          readonly property string dot: root.store
            ? Shipments.tabDot(modelData, root.store.activeShipments, root.store.troubled) : ""
          text: (modelData === "Outgoing" ? "\u{F005D} " : "\u{F0045} ") + modelData + (root.countIn(modelData) > 0 ? " " + root.countIn(modelData) : "")
          selected: root.tab === modelData
          fontSize: Style.font.body
          onClicked: root.setTab(modelData)
          Rectangle {
            visible: tabButton.dot !== ""
            width: Style.space(7); height: width; radius: width / 2
            anchors.top: parent.top; anchors.right: parent.right
            anchors.topMargin: Style.space(2); anchors.rightMargin: Style.space(2)
            color: tabButton.dot === "urgent" ? Color.urgent : Color.accent
          }
        }
      }
    }
    Row {
      id: headerButtons
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)
      Button {
        id: daysButton
        anchors.verticalCenter: parent.verticalCenter
        text: root.store && root.store.days === 30 ? "30 d" : "7 d"
        bordered: true
        fontSize: Style.font.bodySmall
        tooltipText: root.store && root.store.days === 30 ? "Last 30 days · show 7" : "Last 7 days · show 30"
        onClicked: root.store.setDays(root.store.days === 30 ? 7 : 30)
      }
      PanelActionButton {
        id: gearButton
        anchors.verticalCenter: parent.verticalCenter
        iconText: "\u{F0493}"
        tooltipText: "Sources"
        foreground: root.fg
        onClicked: root.sourcesRequested()
      }
      PanelActionButton {
        id: refreshButton
        anchors.verticalCenter: parent.verticalCenter
        iconText: "\u{F0450}"
        tooltipText: "Refresh now"
        foreground: root.fg
        onClicked: root.store.refresh()
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
  }

  // The summary: "2 need you · 1 arriving today · Updated 12 min ago".
  Text {
    width: parent.width
    elide: Text.ElideRight
    text: !root.store ? "" : root.store.summary + (root.store.refreshing ? "Refreshing…"
      : !root.store.anySetUp ? "No Sources connected · manual add only"
      : root.store.lastRun === "" ? "Not refreshed yet"
      : root.store.sourcesState.offline ? "Offline · updated " + Shipments.age(root.store.lastOnline, root.store.nowMs)
      : "Updated " + Shipments.age(root.store.lastRun, root.store.nowMs))
    color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.caption
  }

  // ---- One banner per troubled Connection this tab is affected by (#9, #19).
  // Above the cards, so the empty state keeps it too: an empty list never
  // hides a lost login. needs-login: urgent, lock, Log in (Open for a
  // security check); source-down: muted warning, Retry.
  Repeater {
    model: root.store ? root.store.troubled.filter(function(t) { return Shipments.connectionTabs(t.key).indexOf(root.tab) >= 0 }) : []
    delegate: Rectangle {
      id: banner
      required property var modelData
      readonly property var c: modelData.connection
      readonly property bool down: c.health === "source-down"
      readonly property color tone: down ? Qt.darker(root.fg, 1.3) : Color.urgent
      // The Login progress banner stands in for it while this Connection logs in.
      readonly property bool loggingIn: root.store && root.store.activeLogin && root.store.activeLogin.key === modelData.key
      visible: !loggingIn
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
        text: root.store ? Shipments.bannerText(banner.modelData.key, banner.c, root.store.nowMs)
          + (!banner.down && root.store.loginBlockedText !== "" ? " · " + root.store.loginBlockedText : "") : ""
        color: banner.down ? Qt.darker(root.fg, 1.15) : root.fg
        font.family: root.ff; font.pixelSize: Style.font.bodySmall
      }
      Button {
        id: bannerButton
        anchors.right: parent.right
        anchors.rightMargin: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
        readonly property string actionText: Shipments.bannerAction(banner.c)
        // Retry waits for the run it started; Log in waits for the other Login.
        readonly property bool retrying: actionText === "Retry" && root.store && root.store.refreshing
        enabled: !retrying && !(actionText !== "Retry" && root.store && root.store.activeLogin)
        opacity: enabled ? 1 : 0.45
        text: retrying ? "Retrying…" : actionText
        bordered: true; fontSize: Style.font.bodySmall
        onClicked: {
          if (actionText === "Retry") root.store.retry(banner.modelData.key)
          else root.store.login(banner.modelData.key)
        }
      }
    }
  }

  LoginBanner { width: root.width; store: root.store; fg: root.fg; ff: root.ff }

  // The cards as a ListModel kept in step with the tab's part of
  // store.recentShipments by key, so a card that leaves or arrives (dismissed,
  // shown again, in or out of the 7 / 30 days window) is a remove or insert
  // the ListView animates (a plain array model would rebuild every card).
  // Each item carries the Shipment as JSON.
  ListModel { id: rows }

  function syncRows() {
    var want = root.recent.filter(function(s) { return Shipments.inTab(s, root.tab) })
    var keys = {}
    want.forEach(function(s) { keys[s.key] = true })
    for (var i = rows.count - 1; i >= 0; i--) if (!keys[rows.get(i).key]) rows.remove(i)
    for (var j = 0; j < want.length; j++) {
      var payload = JSON.stringify(want[j])
      var at = -1
      for (var k = j; k < rows.count; k++) if (rows.get(k).key === want[j].key) { at = k; break }
      if (at < 0) {
        rows.insert(j, { key: want[j].key, payload: payload })
        continue
      }
      if (at !== j) rows.move(at, j, 1)
      if (rows.get(j).payload !== payload) rows.setProperty(j, "payload", payload)
    }
  }

  Connections {
    target: root.store
    function onRecentShipmentsChanged() { root.syncRows() }
  }
  onStoreChanged: syncRows()
  Component.onCompleted: syncRows()

  readonly property int slideMs: 200

  // ---- The cards: 4 visible, with the top of a 5th peeking when it scrolls.
  ListView {
    id: list
    width: parent.width
    height: shownCount === 0 ? 0
      : shownCount <= 4 ? shownCount * root.cardHeight + (shownCount - 1) * spacing
      : 4 * (root.cardHeight + spacing) + Math.round(root.cardHeight * 0.4)
    spacing: root.cardSpacing
    // Grows at once; shrinks only after a leaving card has slid out.
    property int shownCount: count
    onCountChanged: if (count >= shownCount) shownCount = count; else shrinkLater.restart()
    Timer { id: shrinkLater; interval: root.slideMs; onTriggered: list.shownCount = list.count }
    Behavior on height { NumberAnimation { duration: root.slideMs; easing.type: Easing.OutCubic } }
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    model: rows

    // Leaving (dismissed, removed, out of the window): slide out to the right,
    // then the cards below move up into the gap. Arriving (an update brought a
    // Dismissed card back, a new Shipment): slide in from the right into its
    // urgency place.
    remove: Transition {
      ParallelAnimation {
        NumberAnimation { property: "x"; to: list.width; duration: root.slideMs; easing.type: Easing.InCubic }
        NumberAnimation { property: "opacity"; to: 0; duration: root.slideMs; easing.type: Easing.InCubic }
      }
    }
    add: Transition {
      NumberAnimation { property: "x"; from: list.width; to: 0; duration: root.slideMs; easing.type: Easing.OutCubic }
    }
    removeDisplaced: Transition {
      SequentialAnimation {
        PauseAnimation { duration: root.slideMs }
        NumberAnimation { properties: "x,y"; duration: root.slideMs; easing.type: Easing.OutCubic }
      }
    }
    displaced: Transition {
      NumberAnimation { properties: "x,y"; duration: root.slideMs; easing.type: Easing.OutCubic }
    }
    move: Transition {
      NumberAnimation { properties: "x,y"; duration: root.slideMs; easing.type: Easing.OutCubic }
    }

    delegate: Rectangle {
      id: card
      required property string key
      required property string payload
      readonly property var s: JSON.parse(payload)
      readonly property bool isTerminal: Shipments.terminal[s.status] === true
      readonly property bool pickup: s.status === "Ready for pickup"
      readonly property bool problem: s.status === "Problem"
      readonly property var progress: Shipments.progress(s)
      readonly property color tone: problem ? Color.urgent : pickup ? Color.accent : root.fg
      readonly property bool removable: (s.connections || []).length === 1 && s.connections[0] === "manual"
      property bool removeHovered: false
      property bool dismissHovered: false
      readonly property bool hot: cardMouse.containsMouse || removeHovered || dismissHovered
      // A "Looking up…" card has nothing to dismiss yet.
      readonly property bool dismissable: String(s.key).indexOf("queued:") !== 0
      // Amazon cards (merged Amazon + DHL ones too, and Orders only mail
      // knows) lead with the item tile, as do DHL cards whose item a mail
      // named (#59); without an image the tile shows the package glyph.
      readonly property bool tiled: s.source === "Amazon" || !!s.itemTitle
      readonly property int tileSize: root.cardHeight - Style.space(16)
      width: list.width
      height: root.cardHeight
      radius: Style.cornerRadius
      color: hot ? Style.hoverFillFor(root.fg, Color.accent) : Style.normalFillFor(root.fg, Color.accent)
      border.width: pickup || problem ? 2 : 0
      border.color: tone
      opacity: isTerminal || s.dismissed === true ? 0.55 : 1

      MouseArea {
        id: cardMouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.openRequested(card.s.url)
      }

      // The item tile: the cached image (a local file; the popup never
      // fetches anything) on white, or the package glyph without one.
      Rectangle {
        id: tile
        visible: card.tiled
        readonly property bool shown: thumb.status === Image.Ready
        width: card.tileSize; height: width
        x: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        radius: Style.cornerRadius
        color: shown ? "white" : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.08)
        Image {
          id: thumb
          visible: tile.shown
          anchors.fill: parent; anchors.margins: Style.space(3)
          source: card.tiled && card.s.image ? "file://" + card.s.image : ""
          sourceSize.width: 96; sourceSize.height: 96
          fillMode: Image.PreserveAspectFit; smooth: true; asynchronous: true
        }
        Text {
          visible: !tile.shown
          anchors.centerIn: parent
          text: "\u{F03D7}"
          color: Qt.darker(root.fg, 1.8); font.family: root.ff; font.pixelSize: Style.font.display
        }
      }

      Column {
        anchors.fill: parent
        anchors.leftMargin: Style.space(10) + (card.tiled ? card.tileSize + Style.space(10) : 0)
        anchors.rightMargin: Style.space(10)
        anchors.topMargin: Style.space(8)
        anchors.bottomMargin: Style.space(8)
        spacing: Style.space(6)

        // Title | badge (| dismiss, remove while hovered)
        Item {
          width: parent.width
          height: Math.max(titleText.implicitHeight, badge.height)
          Text {
            id: titleText
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            width: Math.min(implicitWidth, badge.x - Style.space(8))
            elide: Text.ElideRight
            text: Shipments.cardTitle(card.s)
            color: root.fg; font.family: root.ff; font.pixelSize: Style.font.body; font.bold: true
          }
          Rectangle {
            id: badge
            anchors.right: actions.visible ? actions.left : parent.right
            anchors.rightMargin: actions.visible ? Style.space(4) : 0
            anchors.verticalCenter: parent.verticalCenter
            width: Math.min(badgeText.implicitWidth + Style.space(10), parent.width * 0.55)
            height: badgeText.implicitHeight + Style.space(2)
            radius: Style.cornerRadius
            color: Style.selectedFillFor(root.fg, Color.accent)
            Text {
              id: badgeText
              anchors.centerIn: parent
              width: Math.min(implicitWidth, parent.width - Style.space(10))
              elide: Text.ElideRight
              text: Shipments.sourceLabel(card.s)
              color: root.fg; font.family: root.ff; font.pixelSize: Style.font.caption
            }
          }
          // Hover actions; they tell the card they're hovered so it stays hot.
          Row {
            id: actions
            visible: card.hot && (card.dismissable || card.removable)
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)
            PanelActionButton {
              id: dismissButton
              visible: card.dismissable
              iconText: card.s.dismissed ? "\u{F0208}" : "\u{F0209}" // eye / eye-off
              tooltipText: card.s.dismissed ? "Show again" : "Dismiss until it changes"
              foreground: root.fg
              onHovered: function(isHovered) { card.dismissHovered = isHovered }
              onClicked: card.s.dismissed ? root.store.undismiss(card.s.key) : root.store.dismiss(card.s.key)
            }
            PanelActionButton {
              id: removeButton
              visible: card.removable
              iconText: "\u{F0156}"
              tooltipText: "Remove"
              foreground: root.fg
              hoverColor: Color.urgent
              onHovered: function(isHovered) { card.removeHovered = isHovered }
              onClicked: root.store.remove(card.s.key)
            }
          }
        }

        // The 5-step progress bar, with a marker on its leading edge for
        // Ready for pickup, Problem and Returning.
        Item {
          id: bar
          width: parent.width
          height: Style.space(4)
          readonly property real gap: Style.space(3)
          readonly property real segment: (width - (Shipments.STEPS - 1) * gap) / Shipments.STEPS
          Row {
            anchors.verticalCenter: parent.verticalCenter
            spacing: bar.gap
            Repeater {
              model: Shipments.STEPS
              delegate: Rectangle {
                required property int index
                width: bar.segment
                height: bar.height
                radius: height / 2
                color: Shipments.stepFilled(card.progress, index) ? card.tone : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.15)
              }
            }
          }
          Rectangle {
            visible: card.progress.marker !== ""
            width: Style.space(10); height: width; radius: width / 2
            anchors.verticalCenter: parent.verticalCenter
            // At the end the parcel has reached: the right end of the last
            // filled segment, or the left end when it runs backwards.
            x: card.progress.reverse
              ? (Shipments.STEPS - card.progress.steps) * (bar.segment + bar.gap) - width / 2
              : card.progress.steps * (bar.segment + bar.gap) - bar.gap - width / 2
            color: card.tone
            border.color: card.color.a > 0 ? Color.background : "transparent"
            border.width: 2
          }
        }

        // Status (+ Delayed) | Estimate · age
        Item {
          width: parent.width
          height: Math.max(statusRow.implicitHeight, estimateText.implicitHeight)
          Row {
            id: statusRow
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(6)
            Text {
              anchors.verticalCenter: parent.verticalCenter
              text: Shipments.statusLine(card.s)
              color: card.problem || card.pickup ? card.tone : root.fg
              font.family: root.ff; font.pixelSize: Style.font.bodySmall
            }
            Rectangle {
              id: delayTag
              visible: card.s.delayed === true
              anchors.verticalCenter: parent.verticalCenter
              width: delayText.implicitWidth + Style.space(8)
              height: delayText.implicitHeight + Style.space(2)
              radius: Style.cornerRadius
              color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.25)
              Text { id: delayText; anchors.centerIn: parent; text: "Delayed"; color: root.fg; font.family: root.ff; font.pixelSize: Style.font.caption }
            }
          }
          Text {
            id: estimateText
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            width: Math.min(implicitWidth, parent.width - statusRow.width - Style.space(10))
            horizontalAlignment: Text.AlignRight
            elide: Text.ElideLeft
            text: [Shipments.estimateText(card.s, root.store.nowMs), Shipments.age(card.s.changedAt, root.store.nowMs)]
              .filter(function(t) { return t !== "" }).join("  ·  ")
            color: Qt.darker(root.fg, 1.4); font.family: root.ff; font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }

  // ---- Empty state: first run, or nothing of this tab in the 7 / 30 days window.
  Column {
    visible: list.count === 0 && root.tabDismissedCount === 0
    width: parent.width
    spacing: Style.space(6)
    topPadding: Style.space(10)
    bottomPadding: Style.space(6)
    Text { anchors.horizontalCenter: parent.horizontalCenter; text: root.tab === "Outgoing" ? "\u{F005D}" : "\u{F03D7}"; color: Qt.darker(root.fg, 1.8); font.family: root.ff; font.pixelSize: Style.font.display }
    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      text: !root.store || root.store.nothingTracked ? "Nothing tracked yet"
        : "No " + root.tab + " Shipments in the last " + root.store.days + " days"
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
      text: "Paste a tracking number or Amazon order ID below, or connect DHL and Amazon to find your Shipments automatically."
      color: Qt.darker(root.fg, 1.5); font.family: root.ff; font.pixelSize: Style.font.bodySmall
    }
    // First run (#18 §1): no Source set up yet.
    Button {
      anchors.horizontalCenter: parent.horizontalCenter
      visible: !!root.store && !root.store.anySetUp
      text: "Connect Sources"; selected: true; fontSize: Style.font.bodySmall
      onClicked: root.sourcesRequested()
    }
  }

  // Under the cards: "12 Shipments · scroll for more · 2 dismissed · show".
  Item {
    id: listNotesBox
    width: parent.width
    height: listNotes.implicitHeight
    readonly property bool scrolls: list.count > 4
    readonly property bool anyDismissed: root.tabDismissedCount > 0
    visible: scrolls || anyDismissed
    Row {
      id: listNotes
      anchors.horizontalCenter: parent.horizontalCenter
      Text {
        id: scrollHint
        visible: listNotesBox.scrolls
        text: list.count + " Shipments · scroll for more" + (listNotesBox.anyDismissed ? " · " : "")
        color: Qt.darker(root.fg, 1.6); font.family: root.ff; font.pixelSize: Style.font.caption
      }
      Text {
        id: dismissedLink
        visible: listNotesBox.anyDismissed
        text: visible ? root.tabDismissedCount + " dismissed · " + (root.store.showDismissed ? "hide" : "show") : ""
        color: dismissedMouse.containsMouse ? root.fg : Qt.darker(root.fg, 1.6); font.family: root.ff; font.pixelSize: Style.font.caption
        MouseArea {
          id: dismissedMouse
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: root.store.showDismissed = !root.store.showDismissed
        }
      }
    }
  }

  // Without Node.js the CLI can't add anything (spec #21, "Architecture").
  NodeNotice {
    width: parent.width
    store: root.store; fg: root.fg; ff: root.ff
    text: "Adding tracking numbers needs Node.js, which isn't installed."
  }

  // ---- Footer: manual add
  Row {
    width: parent.width
    spacing: Style.space(6)
    TextField {
      id: addField
      width: parent.width - addButton.width - Style.space(6)
      placeholderText: "\u{F0415} Tracking number or Amazon order ID"
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
  }

  Text {
    visible: root.store && root.store.addError !== ""
    width: parent.width
    wrapMode: Text.WordWrap
    text: root.store ? root.store.addError : ""
    color: Color.urgent; font.family: root.ff; font.pixelSize: Style.font.caption
  }
}
