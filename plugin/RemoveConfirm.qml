// The inline confirmation before a Connection is removed or disconnected
// (#18, spec #21 "Sources page"): "<question> [Remove] [Keep]" in the
// Connection's own row, then "Removing…" while the CLI runs, or why it
// failed. One confirmation at a time (Store.confirmingRemoval). Mail (#34)
// uses it too, with connectionKey "mail".
import QtQuick
import qs.Commons
import qs.Ui

Column {
  id: root
  property var store: null
  property color fg: Color.foreground
  property string ff: Style.font.family
  property string connectionKey: ""
  // e.g. "Remove Amazon · Business? This deletes its Chrome profile and sign-in."
  property string question: ""
  // The button that confirms: "Remove" or "Disconnect".
  property string action: "Remove"
  readonly property bool asking: !!store && store.confirmingRemoval === connectionKey
  readonly property bool running: !!store && store.removingKey === connectionKey
  readonly property bool failed: !!store && store.removeError !== "" && store.removeErrorKey === connectionKey
  visible: asking || running || failed
  spacing: Style.space(6)

  Text {
    width: root.width
    wrapMode: Text.WordWrap
    text: root.running ? (root.action === "Disconnect" ? "Disconnecting…" : "Removing…")
      : root.asking ? root.question : root.store ? root.store.removeError : ""
    color: root.failed && !root.asking && !root.running ? Color.urgent : root.fg
    font.family: root.ff; font.pixelSize: Style.font.bodySmall
  }
  Row {
    visible: root.asking
    spacing: Style.space(6)
    Button {
      enabled: !!root.store && !root.store.removalRuns && root.store.nodeOk !== false
      opacity: enabled ? 1 : 0.45
      bordered: true; text: root.action; fontSize: Style.font.bodySmall
      onClicked: root.store.removeConnection(root.connectionKey)
    }
    Button {
      text: "Keep"; fontSize: Style.font.bodySmall
      onClicked: root.store.keepConnection()
    }
  }
}
