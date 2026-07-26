# Codex Conversion

First-party Piclaw packaging of Igor Warzocha's MIT-licensed [`pi-codex-conversion`](https://github.com/IgorWarzocha/pi-codex-conversion) extension.

Requires Piclaw `>=1.8.0`.

The add-on activates only for supported Codex-like models and adapts those sessions to a narrower Codex-style surface:

- replaces the default core tools (`read`, `bash`, `edit`, `write`) with `exec_command`, `write_stdin`, and `apply_patch`, while preserving other active tools
- conditionally adds model-gated `web_search`, `image_generation`, and `view_image`
- rewrites the composed Pi/Piclaw system prompt with a Codex-oriented delta while preserving project context and skills
- registers an `openai-codex` custom provider shim for native Responses web search and image generation handling
- saves native generated images under `.pi/openai-codex-images/`

## Install

Open **Settings → Add-Ons** and install **codex-conversion** from the catalog. The `node-pty` dependency requires a compiler, `make`, and Python during installation.

## Upstream

- Source: <https://github.com/IgorWarzocha/pi-codex-conversion>
- Upstream package: `@howaboua/pi-codex-conversion`
- License: MIT — copied as [`LICENSE.upstream`](./LICENSE.upstream)
- Upstream README: [`README.upstream.md`](./README.upstream.md)

## Packaging notes

This package keeps the upstream source layout under `src/` and adapts imports to Piclaw's current package names:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `@sinclair/typebox`

It also declares upstream runtime dependencies (`node-gyp`, `node-pty`, `partial-json`, `web-tree-sitter`, `tree-sitter-bash`) so Piclaw's add-on installer can run a nested `bun install` for this package. `node-gyp` is package-local rather than a host-global prerequisite.

## Caveats

`node-pty` is a native dependency. Installation requires a compiler, `make`, and Python. The Piclaw LXC and microVM images include that toolchain; very small deployments may need equivalent native-build tools.
