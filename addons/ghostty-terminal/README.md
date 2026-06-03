# Ghostty Terminal

`@rcarmo/piclaw-addon-ghostty-terminal` provides the Ghostty-powered Piclaw terminal pane as an optional add-on.

Piclaw core defaults to the xterm.js terminal renderer. This add-on is for users who want a more modern and functional Ghostty-web/WASM terminal experience on capable, high-end desktop browsers.

## Behavior

- Registers replacement `terminal` and `terminal-tab` panes.
- Uses the existing Piclaw terminal backend:
  - `/terminal/session`
  - `/terminal/handoff`
  - `/terminal/ws`
- Vendors Ghostty browser assets inside the add-on:
  - `web/vendor/ghostty-web.js`
  - `web/vendor/ghostty-vt.wasm`
  - `web/vendor/ghostty-web.meta.json`
- Keeps Ghostty assets out of Piclaw core until this add-on is installed/enabled.

## Notes

Ghostty-web can be heavier than xterm.js on mobile and low-end machines. Use the core/default terminal for broad compatibility; use this add-on when you want Ghostty's richer terminal behavior on a browser that can comfortably run it.
