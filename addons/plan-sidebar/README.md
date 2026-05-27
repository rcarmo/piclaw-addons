# Plan Sidebar add-on

Adds a right-side slide-out sidebar for the current chat/session plan.

- Live-preview Markdown checklist editor with rendered checkbox controls.
- Persists the plan per `chat_jid` in Piclaw's extension KV store.
- Survives browser refreshes and follows the active web chat/session.
- Provides a Codex-compatible `update_plan` tool for structured plan updates.
- Provides a lower-level `plan` tool for raw Markdown reads, writes, and exact atomic edits.
- Includes a **Submit to model** button that saves the sidebar content and sends it back into the current session as an agent message.

## `update_plan` tool

`update_plan` mirrors Codex's TODO/checklist tool contract: pass the full current plan as structured items with a status for each step.

```json
{
  "explanation": "Reordered after inspecting the code",
  "plan": [
    { "step": "Inspect current code", "status": "completed" },
    { "step": "Port Codex update_plan contract", "status": "in_progress" },
    { "step": "Run targeted tests", "status": "pending" }
  ]
}
```

Statuses:

- `pending` → `- [ ] step`
- `in_progress` → `- [-] step`
- `completed` → `- [x] step`

At most one step may be `in_progress` at a time.

## Raw Markdown `plan` tool

Use `plan` when you need to inspect or precisely edit the underlying Markdown.

```json
{ "action": "read" }
```

```json
{ "action": "write", "markdown": "- [ ] Verify build\n- [ ] Report back" }
```

```json
{
  "action": "edit",
  "edits": [
    { "oldText": "- [ ] Verify build", "newText": "- [x] Verify build" }
  ]
}
```

By default both tools use the active chat/session. Pass `chat_jid` only when intentionally reading or writing another session.
