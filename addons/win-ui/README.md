# @rcarmo/piclaw-addon-win-ui

Windows desktop automation add-on for Piclaw.

This add-on packages the former bundled `runtime/extensions/platform/windows/win-ui` extension as an installable add-on. It registers `win_*` tools on Windows and is a safe no-op on non-Windows platforms.

## Tools

- `win_list_windows` — enumerate visible top-level windows with titles, classes, PIDs, and bounds.
- `win_screenshot` — capture a window by title substring to BMP or PNG.
- `win_desktop_screenshot` — capture the full virtual desktop.
- `win_list_monitors` — enumerate monitors and work areas.
- `win_monitor_screenshot` — capture one monitor by index or device name.
- `win_region_screenshot` — capture an arbitrary desktop region.
- `win_find_elements` — search IAccessible/MSAA elements by name inside a window.
- `win_click` — click coordinates or a named accessibility element.
- `win_type` — send Unicode text or virtual key events to the focused window.
- `win_tree` — dump the IAccessible tree for a window.
- `win_kill` — request close or force-terminate windows/processes by title.

## Platform behavior

The add-on checks `process.platform` and only registers tools on `win32`. It can be installed in cross-platform Piclaw environments without breaking Linux or macOS sessions.

## Notes

The implementation uses Bun FFI against system DLLs (`user32.dll`, `gdi32.dll`, `ole32.dll`, `oleacc.dll`, `oleaut32.dll`) and does not rely on PowerShell, `csc.exe`, or compiled helper binaries.
