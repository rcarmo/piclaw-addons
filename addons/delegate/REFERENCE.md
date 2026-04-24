# Delegate Extension — Complete Reference

**Date:** 2026-04-23  
**Extension:** `/workspace/.pi/extensions/delegate.ts`  
**Skill:** `/workspace/.pi/skills/delegate/SKILL.md`

---

## 1. Why

LLM conversations accumulate context. Every message, tool result, and system prompt stays in the context window until compacted. In a typical PiClaw session:

- **System prompt + memory + skills:** ~6,000+ tokens (always loaded)
- **Conversation history:** grows to 100K–200K+ tokens over a session
- **Every agent call processes the FULL context** — even for "what is 2+2?"

This means a simple file summary costs the same input tokens as a complex architecture discussion. The delegate tool solves this by running tasks in a **fresh context** with a **cheaper model**, then returning the result inline.

**Real-world savings measured:** 5 delegate calls used ~12K total input tokens vs ~893K if done by the main agent — a **99% reduction**.

---

## 2. What

A PiClaw extension that registers a `delegate` tool. When called, it:

1. Selects an appropriate model based on the task category
2. Spawns `pi --print --model <model> --tools <list>` as a subprocess
3. The subprocess runs with its own fresh context (no conversation history)
4. Has access to tools (read, grep, bash, MCP) and skills (web-search, etc.)
5. Returns the response inline to the current conversation

The delegate is a **full agent** — not just an API call. It can read files, run commands, search the web, and use MCP tools. It just doesn't carry the main agent's conversation baggage.

---

## 3. How it works

### Execution flow

```
Main Agent (full context)              Delegate (fresh context)
        │                                      │
        │  delegate({ prompt, category })      │
        │                                      │
        │  1. Select model (tier system)       │
        │  2. Detect visual input → tier bump  │
        │  3. spawn("pi", args) directly       │
        │     --print --no-extensions          │
        │     --model <selected>               │
        │     --tools <profile>                │
        │     -e mcp-adapter                   │
        │     -e safe-workspace-extensions     │
        │     --append-system-prompt <hints>   │
        │     @image.jpg (if binary files)     │
        │                                      │
        │  4. Write prompt to child.stdin      │
        │     child.stdin.end()                │
        │                                      │
        │  5. pi runs with tools ──────────►   │
        │                                      │  Reads files, runs bash
        │                                      │  Uses MCP, web search
        │  ◄─── stdout captured ───────────    │
        │                                      │
        │  6. Return result inline             │
        │  7. Process cleanup (automatic)      │
```

### What the delegate gets

| Resource | How |
|---|---|
| **Tools** | `--tools read,grep,find,ls,bash,mcp` (configurable) |
| **MCP servers** | MCP adapter loaded via `-e`, reads `.pi/mcp.json` |
| **Skills** | Auto-discovered from `.pi/skills/` (web-search, etc.) |
| **Workspace extensions** | Safe extensions from `.pi/extensions/` (excludes delegate itself and UI-only) |
| **Capability hints** | `--append-system-prompt` with web-search and MCP usage instructions |

### What the delegate does NOT get

| Resource | Why |
|---|---|
| **Conversation history** | That's the whole point — fresh context |
| **Memory files** | Not injected (saves tokens) |
| **AGENTS.md** | Not the full version (pi --print uses minimal system prompt) |
| **The delegate tool itself** | Excluded to prevent recursion |
| **UI-only extensions** | Excluded (kanban-board-widget, etc.) |

---

## 4. Model tier system

### 5-tier hierarchy

Models are organized into tiers based on capability and cost. The delegate never picks a model above the current agent's tier.

| Tier | Strength | Speed | Models (preference order) |
|---|---|---|---|
| **1** | Light | Fast | gpt-4o, gpt-4.1, claude-haiku-4.5, grok-code-fast-1 |
| **2** | Medium | Fast | **gpt-5.4-mini**, gpt-5.1-codex-mini, gpt-5-mini, gemini-3-flash-preview |
| **3** | Strong | Medium | **claude-sonnet-4.6**, claude-sonnet-4.5, claude-sonnet-4, gpt-5.4, gpt-5.2, gpt-5.1, gpt-5, gemini-3.1-pro, gemini-3-pro, gemini-2.5-pro |
| **4** | Strong | Medium | gpt-5.3-codex, gpt-5.2-codex, gpt-5.1-codex, gpt-5.1-codex-max |
| **5** | Frontier | Slow | claude-opus-4.7, claude-opus-4.6, claude-opus-4.5 |

**Preference order matters:** Within each tier, the first model in the list is preferred. This means gpt-5.4-mini is chosen over gpt-5-mini (both tier 2), and claude-sonnet-4.6 over claude-sonnet-4 (both tier 3).

### Category → tier mapping

Each task category has a **target tier**. The delegate picks the best model at that tier:

| Category | Target tier | Default pick | Rationale |
|---|---|---|---|
| `quick` | 2 | gpt-5.4-mini | Cheapest capable model — formatting, Q&A, extraction don't need reasoning |
| `summarize` | 2 | gpt-5.4-mini | Fast comprehension is enough — reading + condensing |
| `code` | 3 | claude-sonnet-4.6 | Code gen needs stronger reasoning but not frontier |
| `analyze` | 3 | claude-sonnet-4.6 | Code review and debugging need reasoning depth |
| `reason` | 3 | claude-sonnet-4.6 | Strong reasoning — if you need frontier, don't delegate |
| `judge` | 3 | *Different family* | Must come from a different model family (see below) |

### Tier cap

The delegate never picks a model above the current agent's tier. If you're running on:
- **claude-opus-4.6** (tier 5) → full range available (tiers 1-5)
- **claude-sonnet-4.6** (tier 3) → tiers 1-3 only
- **gpt-5.4-mini** (tier 2) → tiers 1-2 only

### Fallback behavior

If the target tier isn't available (e.g., target is 3 but max is 2), the delegate falls back to the nearest lower tier.

---

## 5. Task categories

### `quick` — Fast and cheap

**Target:** Tier 2 (gpt-5.4-mini)

For tasks that need speed, not depth:
- Factual Q&A ("What is 2+2?")
- Formatting and translation
- Data extraction from structured text
- Simple counting or listing

### `summarize` — Comprehension without reasoning

**Target:** Tier 2 (gpt-5.4-mini)

For condensing information:
- File summaries
- Note digests
- Code overviews
- Meeting notes condensation

### `code` — Code generation and refactoring

**Target:** Tier 3 (claude-sonnet-4.6)

For tasks that need code understanding:
- Code generation
- Refactoring
- Mechanical edits across files
- Writing tests

### `analyze` — Review and debugging

**Target:** Tier 3 (claude-sonnet-4.6)

For tasks that need reasoning about code or systems:
- Code review
- Architecture analysis
- Bug analysis
- Security review

### `reason` — Complex logic

**Target:** Tier 3 (claude-sonnet-4.6)

For multi-step reasoning tasks:
- Planning and design
- Complex problem solving
- Multi-factor decision analysis

**Important:** If a task genuinely needs frontier-level reasoning (opus), don't delegate — do it directly.

### `judge` — Cross-family second opinion

**Target:** Tier 3, **different model family**

For reviewing and critiquing the main agent's output:
- Fact-checking responses
- Catching inaccuracies
- Identifying missing information
- Challenging assumptions

**Cross-family selection:** When the main agent is Claude, the judge picks GPT (and vice versa). This ensures genuinely different training biases — not the same model agreeing with itself.

| Current agent family | Judge picks |
|---|---|
| Claude (opus/sonnet) | gpt-5.4 (GPT family, tier 3) |
| GPT (any) | claude-sonnet-4.6 (Claude family, tier 3) |
| Gemini | claude-sonnet-4.6 (Claude family, tier 3) |

**Triggered by:** User saying "double check", "verify", "review your answer", "second opinion", or similar.

---

## 6. Multimodal support

### How files are handled

The delegate separates files into two types:

| File type | Examples | How passed | Processed by |
|---|---|---|---|
| **Text** | `.ts`, `.md`, `.json`, `.txt`, `.py` | Read as UTF-8, inlined in prompt | All models |
| **Binary/image** | `.png`, `.jpg`, `.pdf`, `.svg`, `.gif` | Passed as `@/path/to/file` arg | Vision-capable models |

### Automatic tier bumping

When binary/image files are detected, the delegate **automatically bumps** the model tier if the auto-selected model is below tier 3:

| Category | Without images | With images |
|---|---|---|
| `quick` | gpt-5.4-mini (tier 2) | **claude-sonnet-4.6 (tier 3)** ↑ bumped |
| `summarize` | gpt-5.4-mini (tier 2) | **claude-sonnet-4.6 (tier 3)** ↑ bumped |
| `code` | claude-sonnet-4.6 (tier 3) | claude-sonnet-4.6 — already tier 3 |
| `analyze` | claude-sonnet-4.6 (tier 3) | claude-sonnet-4.6 — already tier 3 |

**Why:** While all models technically support images, tier 3 models have significantly better visual understanding for dense content like charts, diagrams, screenshots, and PDFs.

**No bump when:** You explicitly set `model` — manual override disables auto-bumping.

### Supported binary extensions

Images: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.tiff`, `.tif`, `.svg`, `.ico`  
Documents: `.pdf`  
Archives: `.zip`, `.tar`, `.gz`  
Media: `.mp3`, `.wav`, `.mp4`, `.webm`

---

## 7. Tool profiles

Three built-in profiles control what tools the delegate can use:

| Profile | Tools | When to use |
|---|---|---|
| `read_only` | read, grep, find, ls, mcp | Safe exploration — can't modify anything |
| `standard` (default) | read, grep, find, ls, bash, mcp | Most tasks — can run commands |
| `full` | read, grep, find, ls, bash, edit, write, mcp | Code generation that writes files |

All profiles include **MCP** access by default.

You can also pass a custom comma-separated tool list: `tools: "read,grep,bash"`.

---

## 8. Extension and skill discovery

### Extensions loaded in delegate

The delegate uses `--no-extensions` to avoid loading itself recursively, then explicitly loads:

1. **MCP adapter** — auto-discovered from bun global install
2. **Safe workspace extensions** — all `.ts` files in `.pi/extensions/` except:
   - `delegate.ts` (prevent recursion)
   - `kanban-board-widget.ts` (UI-only)

New extensions you add to `.pi/extensions/` are automatically available.

### Skills

All skills in `.pi/skills/` are auto-discovered by the delegate's `pi --print` subprocess. This includes:
- Web search (SearXNG)
- Web search summary
- Diagnostics
- Dev tools
- Any skills you add in the future

### Capability hints

Cheap models sometimes don't discover skills on their own. The delegate injects capability hints via `--append-system-prompt`:

```
Web search: run 'bun /workspace/.pi/skills/web-search/web-search.ts --query "QUERY" --fetch true --fetch-limit 3'
Web search summary: run 'bun /workspace/.pi/skills/web-search-summary/web-search-summary.ts --query "QUERY"'
MCP: use the mcp tool with action 'call_tool' to call MCP server tools.
```

---

## 9. Token economics

### Why delegation saves tokens

Every LLM call processes the **full context window**:

```
[system prompt] + [memory] + [conversation history] + [new message]
         ↓                          ↓
    ~6K tokens              100K-200K tokens
```

A delegate call processes only:

```
[minimal system prompt] + [task prompt] + [file contents if any]
         ↓                     ↓                  ↓
    ~1K tokens           ~0.5K tokens        varies
```

### Real-world measurement

From a session with 178K context tokens, 5 delegate calls:

| | Main agent | Delegate | Savings |
|---|---|---|---|
| Input tokens (5 calls) | ~893K | ~12K | **881K (99%)** |
| Context per call | 178K | 0.5-4.5K | Fresh each time |
| Models used | opus (frontier) | mini/sonnet | Cheaper tiers |

### When to delegate vs do directly

| Delegate | Do directly |
|---|---|
| Self-contained task (no history needed) | Needs conversation context |
| Simple/mechanical work | Complex multi-step reasoning |
| File summaries, lookups, searches | Architecture decisions |
| Can describe fully in one prompt | Requires back-and-forth |
| Any task category except frontier-level | Needs the most capable model |

---

## 10. Usage examples

### Natural conversation

You don't need to remember the syntax. Just ask naturally:

- "Summarize my sessions note" → agent delegates with `summarize`
- "How many workitems do I have?" → agent delegates with `quick`
- "Search the web for SearXNG releases" → agent delegates with `quick` + web search
- "Double check that answer" → agent delegates with `judge` (cross-family)
- "Describe this screenshot" → agent delegates with tier bump for image

### Explicit tool calls

```typescript
// Quick factual question
delegate({ prompt: "What is 2+2?", task_category: "quick" })

// File summary
delegate({
  prompt: "Summarize in 3 bullets",
  files: ["notes/piclaw-tasks.md"],
  task_category: "summarize"
})

// Code analysis with specific model
delegate({
  prompt: "List all exported functions",
  files: [".pi/extensions/delegate.ts"],
  task_category: "code"
})

// Web search
delegate({
  prompt: "Search the web for 'SearXNG latest release' and show top 3",
  task_category: "quick"
})

// MCP query
delegate({
  prompt: "Search Microsoft Learn for 'Azure Bicep modules'",
  task_category: "quick"
})

// Image analysis (auto tier bump)
delegate({
  prompt: "Describe this image",
  files: ["screenshot.png"],
  task_category: "quick"  // bumped to tier 3 automatically
})

// Judge / second opinion
delegate({
  prompt: "Review this for accuracy:\n\n<response>\n...\n</response>",
  task_category: "judge"
})

// Full tool access for code generation
delegate({
  prompt: "Create a hello world Express server",
  task_category: "code",
  tools: "full"
})
```

---

## 11. Architecture decisions

| Decision | Rationale |
|---|---|
| `pi --print` subprocess | Uses existing auth, model registry, and tool infrastructure — no need to reimplement |
| Direct `spawn("pi", args)` | No shell wrapper — SIGTERM kills the actual pi process, not a bash parent. Prevents orphaned subprocesses |
| Stdin piping (`child.stdin.write + end`) | Prompt sent directly to pi's stdin. No temp files, no shell escaping issues |
| `settled` guard + shared `cleanup()` | Single-settlement promise: timeout, abort, close, and error all check `settled` flag. `cleanup()` clears timer, kill-timer, and abort listener on every path |
| Self-activation in `before_agent_start` | Extension calls `pi.setActiveTools()` to add itself — no manual `activate_tools` or config needed |
| `--no-extensions` + explicit `-e` | Prevents recursive delegate loading while keeping MCP and safe extensions |
| Temp file for prompt | Avoids shell escaping issues with complex prompts containing quotes, newlines, code |
| `@file` for binary attachments | Native pi syntax for image/PDF passthrough — no base64 encoding needed |
| Category → tier (not model) | Decouples task intent from specific models — works across providers |
| Cross-family judge | Different training biases catch different errors — same-model review is confirmation bias |
| Tier bump for images | Cheap models technically support vision but quality varies significantly |
| Capability hints in system prompt | Cheap models don't proactively discover skills — explicit hints ensure web search and MCP work |
| Models ordered by preference in tier | `find()` returns first match — ordering controls which model is preferred within a tier |

---

## 12. Limitations

- **No streaming** — response is returned all at once after subprocess completes
- **No conversation continuity** — each delegate call is stateless
- **Timeout** — default 120s, max 300s — long tasks may fail
- **Output truncation** — responses capped at 50K chars, buffered output capped at 100K
- **No hard tool enforcement** — tool profiles are allowlists, not blocklists
- **Provider-specific tiers** — model tier table is for github-copilot provider; needs updating for other providers
- **File size limit** — text files >100KB are rejected for inlining (delegate can read them via tools instead)
- **Workspace sandboxed** — files parameter only accepts paths under `/workspace/`

---

## 13. Stress test results

Tested on 12-core ARM / 7.5GB container with `github-copilot/gpt-5.4-mini`.

### Phase 1: basic concurrency

| Concurrency | Success | Avg (ms) | Min (ms) | Max (ms) | Wall (ms) |
|---|---|---|---|---|---|
| 1 | 1/1 | 3,646 | 3,646 | 3,646 | 3,646 |
| 2 | 2/2 | 2,741 | 2,678 | 2,804 | 2,804 |
| 3 | 3/3 | 2,409 | 2,206 | 2,805 | 2,812 |
| 5 | 5/5 | 2,438 | 2,036 | 3,115 | 3,120 |
| 8 | 8/8 | 2,711 | 2,277 | 3,834 | 3,837 |
| 10 | 10/10 | 3,294 | 2,396 | 4,609 | 4,611 |

### Phase 2: higher load + memory monitoring

| Concurrency | Success | Avg (ms) | Max (ms) | Mem delta |
|---|---|---|---|---|
| 10 | 10/10 | 2,472 | 3,038 | +7 MB |
| 15 | 15/15 | 2,910 | 4,553 | +0 MB |
| 20 | 20/20 | 3,331 | 5,616 | +3 MB |
| 25 | 25/25 | 4,033 | 17,567 | +5 MB |
| 30 | 30/30 | 3,847 | 4,647 | +14 MB |

### Key findings

- **Zero failures** at any concurrency level (0–30)
- **Memory is stable** — 7–14 MB delta per batch, fully reclaimed
- **Latency degrades gracefully** — avg 2.5s → 4s at 30 concurrent
- **Bottleneck is the API**, not local resources
- **One outlier** at 25 concurrent (17.6s max) — likely API rate limiting

### Safe concurrency recommendations

| Usage | Max concurrent | Notes |
|---|---|---|
| Normal use | 1–3 | What the agent typically does |
| Safe burst | 10 | Negligible impact |
| Aggressive | 20 | Slight latency increase |
| Limit | 30+ | Works but API may throttle |

### Running the tests

```bash
# From the delegate package directory:

# Phase 1: basic concurrency (1, 2, 3, 5, 8, 10)
bun tests/delegate-stress-test.ts

# Phase 2: higher load + memory monitoring (10, 15, 20, 25, 30)
bun tests/delegate-stress-test-2.ts
```

Both scripts spawn `pi --print` subprocesses directly (same as the extension) and measure success rate, latency, and memory. Adjust `CONCURRENCY_LEVELS`, `MODEL`, and `TIMEOUT_MS` constants at the top of each script.

---

## 14. Auto-activation

The delegate extension **self-activates** on every session start via the `before_agent_start` event hook:

```typescript
pi.on("before_agent_start", async (event) => {
  const active = pi.getActiveTools();
  if (!active.includes("delegate")) {
    pi.setActiveTools([...active, "delegate"]);
  }
  return { systemPrompt: `${event.systemPrompt}\n\n${HINT}` };
});
```

This means:
- **No manual `activate_tools` call needed** — delegate is available from the first message
- **No config required** — works out of the box after dropping the extension file
- **Belt and suspenders** — you can also add `"delegate"` to `additionalDefaultTools` in `.piclaw/config.json` for explicit config control

```json
// .piclaw/config.json
{
  "tools": {
    "additionalDefaultTools": ["delegate"]
  }
}
```

### Recommended for other extensions

If you create workspace extensions that should always be available, use this same pattern:

```typescript
pi.on("before_agent_start", async (event) => {
  const active = pi.getActiveTools();
  if (!active.includes("my_tool")) {
    pi.setActiveTools([...active, "my_tool"]);
  }
  return {};
});
```

This is more reliable than relying on `additionalDefaultTools` config alone, because the config may not take effect until a fresh session.

```
/workspace/.pi/
├── extensions/
│   └── delegate.ts              — Extension source (registers the delegate tool)
├── skills/
│   └── delegate/
│       └── SKILL.md             — Agent skill (when/how to use delegate)
```

---

## 15. Files

```
/workspace/.pi/
├── extensions/
│   └── delegate.ts              — Extension source (registers the delegate tool)
├── skills/
│   └── delegate/
│       └── SKILL.md             — Agent skill (when/how to use delegate)
```
