---
name: delegate
description: Delegate tasks to a cheaper/faster model to save tokens. Use when a task doesn't need the full conversation context.
distribution: public
---

# Delegate

Use the `delegate` tool to offload work to a cheaper/faster model in a fresh context. The delegate has its own tools (read, grep, bash, MCP) but no conversation history — saving tokens.

## When to delegate

- **File summaries** — "summarize this 500-line file" costs the full file in YOUR context; delegate reads it in ITS context instead
- **Quick lookups** — factual questions, counting, listing, formatting
- **Web search** — delegate has MCP + web-search skill access
- **Code generation** — mechanical/boilerplate code that doesn't need conversation context
- **Data extraction** — pull specific info from files without loading them into your context
- **Exploration** — "find all files matching X" or "what does this module do"

## When NOT to delegate

- Task needs conversation history or prior context
- Task requires multiple back-and-forth turns
- Task needs the user to see intermediate steps
- Task is already simple enough to do directly (one grep, one read)

## Key principle

Delegate when the task is **self-contained** — describable in a single prompt without needing "you remember when we discussed X."

## Usage

```
delegate({
  prompt: "Summarize the key concepts in this file",
  files: ["notes/piclaw-sessions.md"],
  task_category: "summarize"
})
```

### Task categories

| Category | When | Model tier |
|---|---|---|
| `quick` | Formatting, factual Q&A, translation | Tier 2 (gpt-5.4-mini) |
| `summarize` | File/note/code summaries | Tier 2 (gpt-5.4-mini) |
| `code` | Code gen, refactoring, boilerplate | Tier 3 (sonnet-4.6) |
| `analyze` | Code review, architecture, debugging | Tier 3 (sonnet-4.6) |
| `reason` | Complex logic, multi-step | Tier 3 (sonnet-4.6) — if you need frontier, don't delegate |
| `judge` | Review/critique agent's last response | Tier 3, **different model family** than current |

## Judge mode

When the user says "double check", "verify", "review your answer", "second opinion", or similar:

1. Capture your last response text
2. Delegate with `task_category: "judge"` and include your response in the prompt
3. The judge model is automatically chosen from a **different family** (if you're Claude, judge will be GPT, and vice versa)

Example:
```
delegate({
  prompt: "Review this response for accuracy, completeness, and potential issues:\n\n<response>\n[paste last response here]\n</response>\n\nBe critical. Flag anything wrong, missing, or misleading.",
  task_category: "judge"
})
```

### Tool profiles

| Profile | Tools | When |
|---|---|---|
| `read_only` | read, grep, find, ls, mcp | Safe exploration only |
| `standard` | read, grep, find, ls, bash, mcp | Most tasks (default) |
| `full` | read, grep, find, ls, bash, edit, write, mcp | Needs to write files |

## Prompt tips

The delegate has **no conversation history**. Write self-contained prompts:

- ❌ "Summarize that file we were looking at"
- ✅ "Summarize /workspace/notes/piclaw-sessions.md in 3 bullets"

- ❌ "Fix the bug"
- ✅ "Read /workspace/.pi/extensions/delegate.ts and check for any shell escaping issues"

Include file paths explicitly. Give clear output format instructions.
