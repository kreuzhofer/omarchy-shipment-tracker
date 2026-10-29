// Design study #90: quickshell entry for render.sh. Loads $VARIANT/Scene.qml (an absolute dir)
// in an offscreen window; the scene grabs itself and quits.
import QtQuick
import Quickshell

ShellRoot {
  FloatingWindow {
    implicitWidth: 900; implicitHeight: 1400
    color: "transparent"
    Loader { source: "file://" + Quickshell.env("VARIANT") + "/Scene.qml" }
  }
}
