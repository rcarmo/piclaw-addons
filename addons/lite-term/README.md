# Lite Term

`@rcarmo/piclaw-addon-lite-term` replaces Piclaw's built-in Ghostty-powered terminal pane with a lighter xterm.js implementation.

It is intended as an option for lower-spec machines that cannot run `ghostty-web` well, or where the Ghostty WASM renderer is too heavy. Lite Term keeps Piclaw's existing terminal backend, authentication, session handoff, theme colors, and terminal font stack, but renders the terminal with vendored xterm.js assets.

## What it includes

Vendored runtime assets:

- `@xterm/xterm`
- `@xterm/addon-attach` — vendored for completeness, not activated because Piclaw uses JSON WebSocket control frames
- `@xterm/addon-canvas`
- `@xterm/addon-clipboard`
- `@xterm/addon-fit`
- `@xterm/addon-image`
- `@xterm/addon-ligatures`
- `@xterm/addon-progress`
- `@xterm/addon-search`
- `@xterm/addon-serialize`
- `@xterm/addon-unicode-graphemes`
- `@xterm/addon-unicode11`
- `@xterm/addon-web-links`
- `@xterm/addon-webgl`

Piclaw's existing Nerd Font assets are used through the same CSS terminal font stack. The add-on does not vendor font files.

## Behavior

- Registers replacement `terminal` and `terminal-tab` panes.
- Uses `/terminal/session`, `/terminal/handoff`, and `/terminal/ws` from the existing backend.
- Sends Piclaw's JSON terminal frames for input and resize.
- Defaults to the canvas renderer for low-spec machines.
- Supports ligatures, Unicode width/grapheme handling, clickable links, clipboard helpers, image protocol rendering, search, serialize support, and progress add-on loading.
- Keeps WebGL vendored and available for experiments.

## Renderer selection

The default renderer is canvas. To force WebGL in a browser tab:

```js
localStorage.setItem("piclaw:lite-term:renderer", "webgl")
location.reload()
```

To return to the default:

```js
localStorage.removeItem("piclaw:lite-term:renderer")
location.reload()
```

## Why not `AttachAddon`?

Piclaw's terminal WebSocket is not a raw PTY byte stream. It exchanges JSON frames such as:

```json
{ "type": "input", "data": "..." }
{ "type": "resize", "cols": 120, "rows": 30 }
{ "type": "output", "data": "..." }
```

`AttachAddon` sends and receives raw terminal bytes, so activating it would bypass Piclaw's resize/control protocol. The add-on vendors it as part of the complete xterm add-on set but uses custom socket glue at runtime.
