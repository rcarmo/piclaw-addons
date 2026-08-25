# Delegate 0.2.8 — Reference

Delegate registers one Pi tool, `delegate`, that runs a self-contained task in a fresh child Pi process. Every child-model launch is restricted to the operator-approved candidate list.

## 1. Enforcement invariant

A model is approved only if its provider is explicitly approved, its ID matches one ordered classification rule, the child CLI lists the exact full ID, and no exclusion denies it. `buildModelCandidates` computes this list. `validateExplicitDelegateModel` applies it to an agent-supplied `model`, `assertApprovedDelegateModelAttempt` checks it again immediately before each child process launch, and `validateDelegateResponseModel` rejects a disclosed message or response model outside the list.

No providers are approved by default. `searchable_providers: null` and `searchable_providers: []` both produce an empty approved list. Discovery of a new provider cannot grant access without an operator changing Delegate settings.

## 2. Catalog contract

Delegate deliberately distinguishes three model roles.

| Role | Source | Purpose |
|---|---|---|
| Runtime models | `ctx.modelRegistry.getAvailable()` | Piclaw-visible providers, capabilities, context/output limits, and diagnostics |
| Executable models | Child `pi --list-models` | The only models allowed in subprocess selection or explicit override |
| Current model | `ctx.model` plus runtime metadata | Establishes the maximum automatic tier and current family |

A runtime-only model is never assumed executable. Conversely, a child-CLI model without runtime metadata can still be classified and executed, but unknown capability fields remain `null` and image selection requires a confirmed `supportsImages: true`.

### Executable cache

- Success TTL: **60 seconds**.
- Child discovery timeout: **20 seconds**.
- A Settings refresh explicitly invalidates the snapshot.
- Failed refresh retains the last known-good model list.
- A failed snapshot is marked stale, records `last_error`, and retries on the next request rather than caching failure for the full TTL.
- Discovery with no prior good data fails the delegation request.

## 3. Classification policy

`classifyModel` normalizes punctuation in the model ID, evaluates ordered rules, and returns exactly one result:

```ts
{
  status: "classified" | "unclassified",
  tier: 1 | 2 | 3 | 4 | 5 | null,
  family: string,
  rule: string | null,
  reason: string,
  confidence: "exact-policy" | "none",
  preference: number
}
```

The first matching rule wins. There is no fuzzy expansion and a full `provider/model` ID can appear in only one tier.

### Policy families

| Tier | Ordered policy families and examples |
|---:|---|
| 1 | Claude Haiku, GPT-4 legacy, Grok Code Fast, LFM local models |
| 2 | GPT Mini/Codex Mini, Gemini Flash (including 3.5 Flash variants), MAI Code Flash, DeepSeek Flash, Gemma, GPT OSS, GLM, Qwen |
| 3 | Claude Fable/Sonnet (including Sonnet 5), GPT 5 general-purpose (including 5.4, 5.5, and 5.6 variants), OpenAI o-series, Gemini Pro, DeepSeek Pro, Mistral Large |
| 4 | GPT Codex/Spark/Max and GPT Pro specialists |
| 5 | Claude Opus, including Opus 4.8 variants |

Rules are provider-independent after exact executable discovery, so direct, GitHub Copilot, Cerebras, Ollama, Azure OpenAI, and Azure Foundry entries are classified by their model ID. Provider filters remain a separate automatic-selection policy. This separation prevents a provider alias from changing a model's tier.

An unclassified current model has no tier ceiling, so automatic delegation fails closed with a policy-update message.

## 4. Candidate construction

`buildModelCandidates`:

1. Deduplicates by full `provider/model` ID.
2. Keeps only providers explicitly approved by the operator and applies provider exclusions.
3. Applies exact, substring, or `*` model-exclusion patterns.
4. Keeps only deterministic classified models.
5. Retains image, reasoning, context-window, and maximum-output metadata.
6. Sorts by tier, policy preference, configured provider preference, then full ID.

The default provider policy approves none. Settings writes the approved and excluded provider partition. The persisted field remains `searchable_providers` for compatibility, but its entries are the operator-approved providers. Names beginning with `azure-` are also excluded when `excluded_providers` is unset.

## 5. Automatic selection

| Category | Target tier |
|---|---:|
| `quick` | 2 |
| `summarize` | 2 |
| `code` | 3 |
| `analyze` | 3 |
| `reason` | 3 |
| `judge` | 3 |

The effective target is capped at the verified current-model tier. Delegate tries the target tier first and then lower tiers. It never searches a higher tier to fill a gap.

Provider preference affects ordering within valid policy candidates. Automatic fallback candidates are deduplicated full IDs and remain at or below the current tier.

### Judge category

Judge selection first looks for an eligible model from a different family than the current model. If no valid cross-family model exists, it falls back to normal tier-safe selection rather than inventing a cross-family guarantee.

### Image capability

When a native raster attachment is present, every automatic or explicit candidate must have `supportsImages === true`. Otherwise it is rejected with a diagnostic that distinguishes missing runtime capability metadata from explicit non-support.

## 6. Explicit model selection

`model` uses exact full-ID semantics:

- It must exactly match an entry in **Settings → Delegate → Approved delegate models**.
- It can bypass automatic current-tier and category-tier selection.
- It cannot bypass provider approval, ordered classification, provider/model exclusions, child-CLI executability, or image-capability validation.
- A runtime-only match reports that Piclaw can see it but child Pi cannot execute it.
- Any other mismatch asks for an exact approved Settings candidate.
- Explicit calls do not use automatic model fallback.

## 7. File contract

All paths are lexically checked, canonicalized with `realpath`, and checked again under `/workspace`; traversal and symlink escapes are rejected. Non-regular files (directories, FIFOs, devices, and sockets) are rejected before content sniffing.

### Text

- A file not recognized as binary is read as UTF-8.
- Maximum inline size is **100 KiB per file**.
- Larger files should be read by the delegated agent using its tools instead.

### Native image attachments

Delegate validates magic bytes, not filename extensions, and accepts only formats Pi can attach natively:

- JPEG
- PNG
- GIF
- WebP
- BMP

The resolved file is passed as a Pi `@/absolute/path` argument.

### Rejected formats

- PDF: extract with `office_read`, `pdftotext`, or another document tool first.
- SVG: render to PNG first.
- TIFF/ICO: convert to PNG or JPEG first.
- ZIP/GZip/7z/RAR/TAR: extract first.
- Audio/video: transcribe or extract text/frames first.
- Unknown binary or extension/signature mismatch: inspect or convert before delegation.

## 8. Child execution

The executable is resolved from `PI_DELEGATE_CLI`, the current Bun runtime plus the installed Pi CLI script, or finally a `pi` executable on `PATH`.

Representative arguments:

```text
--mode json
--no-session
--no-extensions
--model <exact-provider/model>
--tools <comma-separated-profile>
[-e <mcp-adapter>]
--append-system-prompt <delegate hints>
[@/workspace/image.png ...]
```

The prompt is written to stdin. There is no shell wrapper and no prompt temp file.

### Extension trust boundary

`--no-extensions` is always used. Delegate may explicitly load:

1. The known MCP adapter entrypoint when installed.
It does not recursively load Delegate, inherit Piclaw add-on tools, or scan/load arbitrary top-level workspace `.ts` extensions.

### Structured JSON protocol

Delegate parses newline-delimited Pi events:

- `session`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `turn_end`
- `agent_end`

It returns final assistant text plus provider/model, response model, stop reason, aggregated usage/cost, tool-call count, fallback attempts, truncation state, and ephemeral-session status. Duplicate assistant payloads emitted in both `message_end` and `turn_end` are deduplicated.

Tool and message progress is surfaced through bounded `onUpdate` calls. A real process/protocol failure is thrown rather than returned as a successful tool result.

## 9. Lifecycle bounds

| Bound | Value |
|---|---:|
| Default timeout | 120 s |
| Accepted timeout range | 10–300 s |
| Final response | 50,000 characters |
| Accumulated assistant text | 100,000 characters |
| stderr | 64,000 characters |
| Raw event accounting | 20,000 events |
| Progress updates | 128 events |

One absolute deadline covers discovery completion, the selected attempt, and every fallback attempt. Each subsequent child receives only the remaining time.

On timeout or cancellation Delegate sends `SIGTERM` to the detached child process group, waits briefly, then escalates to `SIGKILL`. It removes listeners/timers and rejects only after close, preventing descendants and session files from surviving the call.

`--no-session` ensures the child does not create a persistent Pi session.

## 10. Failure and fallback policy

Failures are classified as:

- `auth`
- `model-unavailable`
- `provider-setup`
- `timeout`
- `aborted`
- `protocol`
- `execution`

Automatic fallback is permitted only for `auth`, `model-unavailable`, and `provider-setup`. Each fallback ID comes from the approved candidate list and is checked against that list again immediately before spawn.

The following do not trigger retry: malformed/no JSON events, non-zero exit without a classified setup cause, timeout, cancellation, rate limit, tool error, and ordinary execution failure. Partial assistant text with a non-zero exit remains a failure.

Every failure stores the attempted full model ID, classification, and message. The thrown final error includes the complete attempt chain and the actual final attempted model.

## 11. Tool schema

```ts
{
  prompt: string,                 // required
  task_category?: "quick" | "summarize" | "code" | "analyze" | "reason" | "judge",
  model?: string,                 // exact approved provider/model selection
  files?: string[],               // workspace text or native raster files
  tools?: "read_only" | "standard" | "full" | string,
  system_prompt?: string,
  timeout_sec?: number            // 10..300
}
```

The category uses a Google-compatible string enum schema.

Tool profiles:

| Profile | Built-in tools |
|---|---|
| `read_only` | `read,grep,find,ls` |
| `standard` | `read,grep,find,ls,bash` |
| `full` | `read,grep,find,ls,bash,edit,write` |

If the known MCP adapter is installed, Delegate adds the `mcp` tool and loads that adapter explicitly.

## 12. Result details

Successful calls include structured details similar to:

```json
{
  "model": "github-copilot/gpt-5.4-mini",
  "actual_model": "github-copilot/gpt-5.4-mini",
  "response_model": null,
  "category": "summarize",
  "explicit_override": false,
  "fallback_count": 0,
  "attempts": [{ "model": "github-copilot/gpt-5.4-mini", "status": "success" }],
  "stop_reason": "stop",
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0, "totalTokens": 0, "cost": 0 },
  "tool_calls": 0,
  "output_truncated": false,
  "ephemeral_session": true
}
```

## 13. Settings diagnostics

The Delegate Settings pane uses the direct add-on config API and reports:

- Runtime model count and current model classification.
- Child-CLI model count and approved candidate count.
- Runtime-only models.
- Unclassified and other rejected executable models with reasons.
- Cache refresh timestamp, age, stale state, and last refresh error.
- Per-candidate image, reasoning, context-window, and output-limit flags.
- Effective provider/model exclusions.
- Manual refresh and provider/model policy controls.

## 14. Limitations

- Delegates have no conversation continuity; prompts must be self-contained.
- The final answer is emitted after child exit, although bounded progress is streamed while running.
- Policy updates are required for genuinely new model IDs; unknown current models intentionally fail closed.
- Runtime-only, unapproved-provider, unclassified, and excluded models cannot be explicitly delegated.
- Image support is fail-closed when runtime capability metadata is absent.
- Child tool profiles restrict the tool list but are not an operating-system sandbox. A child granted `bash` or external MCP services can execute capabilities outside Delegate's child-model launcher.
- MCP is available only when its adapter can be discovered; other Piclaw add-on tools are not inherited by the child.
