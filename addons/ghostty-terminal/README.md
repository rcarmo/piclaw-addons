# Ghostty Terminal

`@rcarmo/piclaw-addon-ghostty-terminal` restores the former Ghostty-powered Piclaw terminal pane as an optional add-on.

Piclaw core now defaults to the lighter xterm.js terminal renderer. This add-on is for users who explicitly want to try the Ghostty-web/WASM renderer on capable desktop browsers.

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

Ghostty-web can be heavier than xterm.js on mobile and low-end machines. Use the core/default terminal unless you specifically need Ghostty behavior.
