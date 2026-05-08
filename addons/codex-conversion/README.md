# Codex Conversion

First-party Piclaw packaging of Igor Warzocha's MIT-licensed [`pi-codex-conversion`](https://github.com/IgorWarzocha/pi-codex-conversion) extension.

The add-on adapts OpenAI/Codex-like model sessions to a narrower Codex-style surface:

- swaps active tools to `exec_command`, `write_stdin`, `apply_patch`, plus model-gated `web_search`, `image_generation`, and `view_image`
- rewrites the composed Pi/Piclaw system prompt with a Codex-oriented delta while preserving project context and skills
- registers an `openai-codex` custom provider shim for native Responses web search and image generation handling
- saves native generated images under `.pi/openai-codex-images/`

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

It also declares upstream runtime dependencies (`node-pty`, `partial-json`, `web-tree-sitter`, `tree-sitter-bash`) so Piclaw's add-on installer can run a nested `bun install` for this package.

## Caveats

`node-pty` is a native dependency. Installation requires the host to have the normal build toolchain available. The Piclaw LXC images used for development include `build-essential`, but very small deployments may need equivalent native-build tools.
