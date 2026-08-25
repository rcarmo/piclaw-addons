# Delegate

Delegate runs self-contained work in a fresh, ephemeral child Pi and restricts every child launch to an operator-approved model.

Requires Piclaw `>=1.8.0`.

## Approved-model boundary

Delegate can launch a model only when all four conditions hold:

1. An operator marked its provider **Approved** in **Settings → Delegate**. No provider is approved by default.
2. Its model ID matches one ordered, code-reviewed classification rule.
3. The child `pi --list-models` catalog contains the exact `provider/model` ID.
4. No provider or model exclusion denies it.

The Settings pane lists the resulting **Approved delegate models**. That list is the execution allowlist for automatic selection, an agent-supplied `model`, and fallback attempts. Agents cannot expand it through the `delegate` tool arguments, prompts, custom system prompts, or fallback errors. If a provider discloses a different message or response model, Delegate accepts the result only when that exact model is also approved.

## Behaviour

- **Verified model catalogs** — Piclaw's runtime registry supplies capability metadata; exact child `pi --list-models` entries establish executability.
- **Deterministic policy** — every recognized model has one family, one tier, one ordered rule, and a classification reason. Unknown models fail closed.
- **Approved providers** — an unset or empty provider list approves nothing. Newly discovered providers remain denied until an operator approves them.
- **Tier-safe automatic selection** — automatic delegation never selects above the verified current-model tier.
- **Exact explicit selection** — `model` can choose an exact member of the approved list and bypass automatic tier selection. It cannot bypass provider approval, classification, exclusions, executability, or image-capability checks.
- **Pre-spawn enforcement** — Delegate checks the approved list immediately before every child process launch, including fallback attempts.
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

### Explicit model selection

```ts
delegate({
  prompt: "Review this implementation.",
  task_category: "analyze",
  model: "github-copilot/gpt-5.4-mini"
})
```

The ID must appear in **Settings → Delegate → Approved delegate models**. Explicit selection can bypass the automatic tier choice, but it cannot use an unapproved provider, an unclassified or excluded model, a runtime-only model, or a model without the required image capability.

## Files

- Text files are UTF-8-inlined up to **100 KiB** each.
- Native raster attachments are accepted only after content sniffing: **JPEG, PNG, GIF, WebP, and BMP**.
- Extensions do not determine attachment type; spoofed files are rejected.
- PDF, SVG, TIFF/ICO, archives, audio, video, and unknown binary data are rejected with conversion or tool-reading guidance.
- Canonical paths must remain under `/workspace`; symlinks cannot escape it, and non-regular files are rejected before sniffing.

For a PDF or Office document, extract it with the appropriate Piclaw tool and delegate the resulting text. Convert unsupported images to PNG, JPEG, GIF, WebP, or BMP first.

## Settings API

The browser pane reads configuration from `/agent/addons/api/delegate/config` and model diagnostics from `/agent/addons/api/delegate/models`. Both are authenticated local Piclaw endpoints; Delegate stores no secrets.

Each discovered provider has one mutually exclusive mode: **Approved** or **Exclude**. Changing modes writes a complete partition to the persisted `searchable_providers` and `excluded_providers` fields. The legacy field name `searchable_providers` now stores the operator-approved provider list. A missing or empty list approves no providers.

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
- Unclassified current models disable automatic delegation until policy is updated. Explicit selection still requires an approved, classified candidate.
- Model policy is intentionally explicit and must be updated for genuinely new model families or variants.
- Core tool profiles are child allowlists, not an operating-system sandbox. A child granted `bash` or external MCP services can execute capabilities outside Delegate's child-model launcher; use `read_only` and a restricted environment when that distinction matters.

See [REFERENCE.md](REFERENCE.md) for the full selection, execution, and diagnostics contract.
