# Delegate

Delegate self-contained work to a cheaper/faster model in a fresh, ephemeral Pi context.

Requires Piclaw `>=1.8.0`.

## Behaviour

- **Verified model catalogs** — Piclaw's runtime registry supplies capability metadata; only exact models returned by child `pi --list-models` are executable.
- **Deterministic policy** — every recognized model has one family, one tier, one ordered rule, and a classification reason. Unknown current models fail closed.
- **Tier-safe automatic selection** — automatic delegation never selects above the verified current-model tier.
- **Exact explicit overrides** — `model` must be an executable `provider/model` ID. Overrides bypass automatic tier and provider policy, but never configured model exclusions, executability, or image-capability checks.
- **Capability filtering** — image input requires catalog-confirmed image support. Reasoning, context-window, and output-limit metadata are retained for diagnostics.
- **Ephemeral structured execution** — the child runs with `--mode json --no-session --no-extensions`; Delegate parses structured messages, tool progress, usage, model, stop reason, and errors.
- **Bounded lifecycle** — one total deadline covers all fallback attempts; cancellation terminates the process tree, output buffers are bounded, and no child session is persisted.
- **Restricted fallback** — automatic retry occurs only for classified provider setup, authentication, or model-unavailable failures. A non-zero exit never succeeds merely because partial text was emitted.
- **Narrow tool loading** — Delegate loads Pi's requested core tool profile plus the explicitly discovered MCP adapter; it does not inherit or scan arbitrary workspace/add-on extensions.
- **Catalog diagnostics** — Settings shows runtime/CLI counts, eligible and runtime-only models, unclassified/rejected models and reasons, cache age, refresh failures, capabilities, and effective exclusions.

## Installation

Open **Settings → Add-Ons**, install **Delegate**, then reload Piclaw when convenient. Installing or updating the package does not activate new code until Piclaw reloads.

Delegate self-activates after reload. It may also be listed explicitly in `.piclaw/config.json`:

```json
{
  "tools": {
    "additionalDefaultTools": ["delegate"]
  }
}
```

## Usage

```ts
delegate({
  prompt: "Summarize the public API and list compatibility risks.",
  files: ["src/client.ts"],
  task_category: "summarize"
})
```

### Task categories

| Category | Automatic target | Use for |
|---|---:|---|
| `quick` | Tier 2 | Formatting, extraction, translation, factual Q&A |
| `summarize` | Tier 2 | File, note, and code summaries |
| `code` | Tier 3 | Code generation and mechanical refactoring |
| `analyze` | Tier 3 | Code review, architecture analysis, debugging |
| `reason` | Tier 3 | Complex planning and multi-step logic |
| `judge` | Tier 3 | A second opinion from another family when a valid alternative exists |

The requested tier is capped at the current model's verified tier. If that tier has no eligible model, Delegate searches lower tiers. Judge mode crosses families only when an eligible alternative exists.

### Tool profiles

| Profile | Child tools |
|---|---|
| `read_only` | `read,grep,find,ls` |
| `standard` (default) | `read,grep,find,ls,bash` |
| `full` | `read,grep,find,ls,bash,edit,write` |

A discovered MCP adapter is appended only when explicitly available. A custom comma-separated list of child Pi built-ins is also accepted. A named tool must exist in the child; installed Piclaw add-on tools are not inherited automatically.

### Explicit model override

```ts
delegate({
  prompt: "Review this implementation.",
  task_category: "analyze",
  model: "github-copilot/gpt-5.4-mini"
})
```

The ID must exactly match the child CLI catalog. An explicit override bypasses automatic tier and provider policy, but a configured model exclusion still blocks it. The model must also support any attached image.

## Files

- Text files are UTF-8-inlined up to **100 KiB** each.
- Native raster attachments are accepted only after content sniffing: **JPEG, PNG, GIF, WebP, and BMP**.
- Extensions do not determine attachment type; spoofed files are rejected.
- PDF, SVG, TIFF/ICO, archives, audio, video, and unknown binary data are rejected with conversion or tool-reading guidance.
- Canonical paths must remain under `/workspace`; symlinks cannot escape it, and non-regular files are rejected before sniffing.

For a PDF or Office document, extract it with the appropriate Piclaw tool and delegate the resulting text. Convert unsupported images to PNG, JPEG, GIF, WebP, or BMP first.

## Settings API

The browser pane reads configuration from `/agent/addons/api/delegate/config` and model diagnostics from `/agent/addons/api/delegate/models`. Both are authenticated local Piclaw endpoints; Delegate stores no secrets.

Each provider has one mutually exclusive mode: **Search**, **Ignore**, or **Exclude**. Changing modes writes `searchable_providers` and `excluded_providers` together, so selecting Search also removes a prior exclusion.

## Model catalogs and caching

Delegate keeps these roles separate:

1. **Runtime catalog** — `ctx.modelRegistry`; capability metadata and the current model.
2. **Executable catalog** — child `pi --list-models`; the only source of subprocess candidates.
3. **Current model** — classified independently to establish the automatic tier ceiling.

Executable discovery is cached for 60 seconds. A manual Settings refresh invalidates it. Failed refreshes preserve the last known-good snapshot, expose the error, and remain stale so the next request retries automatically.

## Failure and timeout behavior

- Default timeout: **120 seconds**; allowed range: **10–300 seconds**.
- The timeout is one total deadline across the initial attempt and every fallback.
- Cancellation and timeout terminate the child process group, escalating from `SIGTERM` to `SIGKILL` if necessary.
- Automatic fallback is limited to provider setup, authentication, and unavailable-model errors.
- Protocol failures, malformed JSON, timeouts, aborts, rate limits, tool failures, and ordinary execution errors are not retried.
- Final response text is capped at **50,000 characters**; structured output and stderr buffers are bounded separately.

## Limitations

- Every call is stateless and has no conversation history.
- The final result is returned when the child exits; structured tool/message progress is emitted through `onUpdate` while it runs.
- Runtime-only Piclaw models cannot be used until the child CLI also lists them.
- Unclassified current models disable automatic delegation until policy is updated; exact executable overrides remain available.
- Model policy is intentionally explicit and must be updated for genuinely new model families or variants.
- Core tool profiles are child allowlists, not a filesystem sandbox.

See [REFERENCE.md](REFERENCE.md) for the full selection, execution, and diagnostics contract.
