---
name: delegate
description: Delegate a self-contained task to a verified cheaper/faster child-Pi model in a fresh ephemeral context.
distribution: public
---

# Delegate

Use the `delegate` tool for self-contained work that does not need the conversation history. The child runs with a verified executable model, a bounded tool profile, and no persistent Pi session.

## Good delegation candidates

- File, note, or code summaries
- Formatting, translation, extraction, and factual questions
- Mechanical code generation or refactoring
- Focused repository exploration and debugging
- A second-opinion review using `judge`

Do not delegate when the task depends on conversation history, needs user interaction, requires frontier capability, or is simpler than describing a complete standalone prompt.

## Call shape

```ts
delegate({
  prompt: "Read src/client.ts. Summarize its public API in five bullets and identify compatibility risks.",
  files: ["src/client.ts"],
  task_category: "summarize",
  tools: "read_only"
})
```

### Categories

| Category | Target | Use for |
|---|---:|---|
| `quick` | Tier 2 | Formatting, extraction, translation, factual Q&A |
| `summarize` | Tier 2 | File, note, and code summaries |
| `code` | Tier 3 | Code generation and refactoring |
| `analyze` | Tier 3 | Review, architecture, and debugging |
| `reason` | Tier 3 | Complex planning and multi-step logic |
| `judge` | Tier 3 | Critical review from another family when available |

Automatic selection is capped at the verified tier of the current model. If the current model is unknown to Delegate policy, automatic selection fails closed.

## Explicit overrides

Use `model: "provider/model"` only when an exact executable child-CLI model is required. Overrides bypass automatic tier and configured provider/model exclusions, but they do not bypass executability or image-capability checks. A model visible only to Piclaw runtime is not enough.

## Tool profiles

| Profile | Built-in child tools |
|---|---|
| `read_only` | `read,grep,find,ls` |
| `standard` (default) | `read,grep,find,ls,bash` |
| `full` | `read,grep,find,ls,bash,edit,write` |

If the known MCP adapter is installed, Delegate adds the `mcp` tool. A custom comma-separated list of Pi child built-ins is accepted; custom lists must name `mcp` explicitly when needed. Do not assume other Piclaw add-on tools are present.

## Files

- Text files are inlined up to 100 KiB each.
- Only content-sniffed JPEG, PNG, GIF, WebP, and BMP files are attached natively.
- PDF, SVG, TIFF/ICO, archives, audio, video, and unknown binary data are rejected.
- Extract document text or convert unsupported images before delegation.
- Canonical file paths must stay under `/workspace`; symlink escapes and non-regular files are rejected.

## Judge mode

When the user asks to double-check, verify, review, or obtain a second opinion:

```ts
delegate({
  prompt: "Review the response below for correctness, omissions, and unsupported claims. Be critical.\n\n<response>\n...\n</response>",
  task_category: "judge",
  tools: "read_only"
})
```

Judge selection crosses families only when a valid tier-safe executable alternative exists.

## Prompt discipline

The child has no conversation history. Include all necessary facts, paths, constraints, and the desired output shape.

- Bad: `"Fix the bug we discussed."`
- Good: `"Read src/cache.ts and tests/cache.test.ts. Diagnose why stale entries survive invalidate(), propose the smallest fix, and return a patch outline."`

Use the final result normally. While it runs, Delegate may emit bounded structured status/tool progress. It retries automatically only for provider setup, authentication, or unavailable-model failures; ordinary execution, protocol, timeout, cancellation, and rate-limit failures are returned without retry.
