# Plan Sidebar add-on

Adds a right-side slide-out sidebar for the current chat/session plan.

- Live-preview Markdown checklist editor with rendered checkbox controls.
- Persists the plan per `chat_jid` in Piclaw's extension KV store.
- Survives browser refreshes and follows the active web chat/session.
- Provides one canonical model-facing `plan` tool for structured updates and raw Markdown reads/edits.
- Stores plans as Markdown while exposing consistent structured plan data in tool/API responses.
- Auto-refreshes the visible/sidebar meter on `plan.changes` events from tool or API mutations without clobbering dirty local edits.
- Includes **Refresh**, **Reset**, **Save**, and **Submit to model** controls; Reset restores the canonical default checklist through the same storage API.

## `plan` tool

Use `plan action=patch` for the common case: add, edit, or remove multiple checklist items without exact Markdown line replacements or rewriting the entire plan.

```json
{
  "action": "patch",
  "patches": [
    { "operation": "update", "match": "Inspect current code", "status": "completed" },
    { "operation": "update", "match": "Patch plan tool", "step": "Patch plan tool batch edits", "status": "in_progress" },
    { "operation": "add", "after": "Patch plan tool batch edits", "step": "Run targeted tests", "status": "pending" },
    { "operation": "remove", "match": "Obsolete placeholder" }
  ]
}
```

Patch operations run in order. `update` and `remove` can target an existing item with a 1-based `index` or a unique `match` against the step text. `add` accepts `position: "start" | "end"`, `before`, or `after`; it defaults to appending.

Use `plan action=update` for Codex-style structured full-plan replacement when you already know the whole desired checklist. The stored format remains Markdown, but every mutation path is normalized through the same parser/formatter.

```json
{
  "action": "update",
  "explanation": "Reordered after inspecting the code",
  "plan": [
    { "step": "Inspect current code", "status": "completed" },
    { "step": "Port plan action=update contract", "status": "in_progress" },
    { "step": "Run targeted tests", "status": "pending" }
  ]
}
```

Statuses map to canonical Markdown markers:

- `pending` → `- [ ] step`
- `in_progress` → `- [-] step`
- `completed` → `- [x] step`

At most one step may be `in_progress` / `[-]` at a time, regardless of whether the plan is patched, updated structurally, written as Markdown, edited atomically, reset, or saved through the sidebar API.

Use raw Markdown actions only when you need to inspect or precisely edit the underlying document:

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

`action=edit` also supports batching multiple exact Markdown operations in one call. Prefer `action=patch` unless you specifically need raw Markdown anchors:

```json
{
  "action": "edit",
  "edits": [
    { "operation": "replace", "oldText": "- [ ] Inspect current state", "newText": "- [x] Inspect current state" },
    { "operation": "insert_after", "anchorText": "- [x] Inspect current state", "text": "\n- [-] Patch the plan tool\n- [ ] Run focused tests" },
    { "operation": "delete", "oldText": "\n- [ ] Obsolete placeholder" },
    { "operation": "append", "text": "\n- [ ] Report the result" }
  ]
}
```

Supported edit operations:

- `replace` — replace `oldText` with `newText` (legacy default when both fields are present)
- `delete` — remove `oldText`
- `insert_after` / `insert_before` — insert `text` around an exact `anchorText`
- `append` / `prepend` — add `text` at the end or beginning

Anchors and old text must match exactly once. Inserted text may contain multiple checklist lines.

Tool/API details include both the stored Markdown and parsed structured items:

```json
{
  "chat_jid": "web:addons",
  "markdown": "- [x] Inspect\n- [-] Patch\n- [ ] Test",
  "updated_at": "2026-05-27T16:30:00.000Z",
  "explanation": null,
  "plan": [
    { "step": "Inspect", "status": "completed" },
    { "step": "Patch", "status": "in_progress" },
    { "step": "Test", "status": "pending" }
  ]
}
```

By default the tool uses the active chat/session. Pass `chat_jid` only when intentionally reading or writing another session.
