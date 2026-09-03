# piclaw-addon-codex-conversion

Provider-aware Codex and Copilot prompt and tool profiles for Piclaw.

Requires Piclaw `>=2.15.0` and its Earendil/pi-ai `0.84.4` provider surface.

This is first-party Piclaw packaging of the prompt, tool and shell work from Igor Warzocha's MIT-licensed [`pi-codex-conversion`](https://github.com/IgorWarzocha/pi-codex-conversion) extension. Piclaw uses pi-ai's built-in provider transport for ordinary requests. The add-on does not replace provider OAuth, model discovery or endpoint selection.

## Profiles

| Selected model | Profile | Behaviour |
|---|---|---|
| `openai-codex/*` or the explicit `openai-codex-responses` API | `codex-tools` | Codex-oriented prompt and tools |
| `github-copilot/gpt*` | `copilot-tools` | The same coding tools with VS Code Copilot Chat inference headers |
| Direct OpenAI GPT, OpenRouter models and unrelated providers | `native` | Piclaw/Pi tools and prompt remain unchanged |

Profile selection is intentionally explicit. Tool naming does not change provider identity, credentials or transport.

## Adapted tools

The `codex-tools` and `copilot-tools` profiles replace the default core tools:

```text
read  bash  edit  write
```

with:

```text
exec_command  write_stdin  apply_patch
```

Other active tools remain available. Switching back to a native profile restores the previous core tool selection and preserves tools added by other extensions.

- `exec_command` runs shell commands through pipes or a PTY and returns a `session_id` for work that remains active.
- `write_stdin` sends input to or polls a running command session.
- `apply_patch` applies OpenAI-style multi-file patches and reports partial failures with file-specific recovery instructions.
- `view_image` is added for image-capable adapted models. Original-resolution detail remains restricted to Codex-family models.

`web_search` and `image_generation` are registered for on-demand activation on supported OpenAI Codex models. Keeping them inactive on ordinary turns avoids cloning provider responses. Activating either tool enables the bounded native-output observer for that turn.

The add-on also appends bounded Codex-oriented guidance to Piclaw's composed system prompt. Project instructions, available skills, current shell and other Piclaw context remain present.

## Provider transport ownership

### OpenAI Codex

pi-ai owns the `openai-codex-responses` transport, including:

- ChatGPT Codex OAuth and account handling;
- `/backend-api/codex/responses` endpoint resolution;
- WebSocket transport with SSE fallback;
- zstd request compression;
- prompt-cache and session identifiers;
- Responses message and tool conversion;
- encrypted reasoning replay;
- grammar and deferred tools;
- retry-delay limits, proxy handling, diagnostics and session cleanup.

The add-on's provider overlay delegates every request to pi-ai's built-in `streamSimple`. pi-ai 0.84.4 does not expose completed native `image_generation_call` or `web_search_call` output items to extensions. For turns that advertise either native tool, the overlay forces pi-ai's SSE transport and inspects a cloned successful response through the standard `fetch` option. pi-ai still owns request serialization, OAuth, endpoint selection, headers, retries, proxy handling, protocol parsing, diagnostics and the assistant event stream. The add-on only saves image bytes and formats search activity from the cloned response.

### GitHub Copilot

GitHub Copilot inference requests retain pi-ai's dynamic and security-sensitive headers. The add-on updates the tested VS Code Copilot Chat compatibility fields through `before_provider_headers`:

```text
User-Agent: GitHubCopilotChat/0.48.1
Editor-Version: vscode/1.136.0
Editor-Plugin-Version: copilot-chat/0.48.1
Copilot-Integration-Id: vscode-chat
```

It does not replace or remove `Authorization`, `X-Initiator`, `Openai-Intent`, `Copilot-Vision-Request`, request IDs or other request-specific fields. Non-Copilot requests are unchanged.

The header hook applies to model inference requests. GitHub Copilot OAuth refresh and `/models` discovery remain pi-ai-owned and use the compatibility fields bundled with the installed Earendil release.

The profile records `reviewedAt: 2026-09-03` and exposes an offline 90-day staleness check. Tests make an overdue compatibility review visible without calling GitHub or the VS Code Marketplace at runtime.

## Native provider tools

`web_search` remains available on `openai-codex` and is rewritten from a function declaration to the provider's native Responses `web_search` tool before dispatch. The request explicitly includes `web_search_call.action.sources` and `web_search_call.results`, so search results inform the model's answer and retain the foldable query/source activity card through the bounded observer.

Native `image_generation` remains available for image-capable OpenAI Codex models. Generated files are saved under `.pi/openai-codex-images/`, with `latest.png` updated after each result. The bounded response observer above receives the image bytes.

Existing sessions may contain old `codex-web-search-activity`, `codex-image-generation-display` or session-note messages. The context hook keeps those display records out of future model requests.

## Status behaviour

The active profile badge is a TUI footer status only:

```text
Codex tools
Copilot tools
```

It uses the active TUI theme and is not emitted in RPC, web, JSON or print modes. No ANSI escape sequence is stored in a cross-mode status constant.

## Runtime dependencies

The add-on uses Bun's native terminal implementation and does not require `node-pty`, `node-gyp`, Python or a compiler. Its remaining runtime parser dependencies are:

- `web-tree-sitter`
- `tree-sitter-bash`

## Upgrade and rollback

Version 0.2.0 stops adapting direct OpenAI GPT and other OpenAI-compatible models. OpenAI Codex and GitHub Copilot GPT sessions keep the adapted coding tools; RPC and web sessions stop receiving the old status event. Existing sessions need no migration.

To roll back, install `piclaw-addon-codex-conversion-0.1.5.tgz` from the public packages archive and reload extensions. The older release restores broad model matching, the persistent cross-mode status and its custom OpenAI Codex transport.

## Validation

The package tests cover:

- provider/profile selection;
- GitHub Copilot header scoping and dynamic-header preservation;
- TUI versus RPC/JSON/print lifecycle behaviour;
- tool replacement and restoration;
- persistent pipe and PTY command sessions;
- terminal control-sequence handling;
- standalone package import.

## Upstream

- Source: <https://github.com/IgorWarzocha/pi-codex-conversion>
- Upstream package: `@howaboua/pi-codex-conversion`
- Licence: MIT — copied as [`LICENSE.upstream`](./LICENSE.upstream)
- Upstream README at the time of packaging: [`README.upstream.md`](./README.upstream.md)
