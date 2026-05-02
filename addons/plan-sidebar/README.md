# Plan Sidebar add-on

Adds a right-side slide-out sidebar for the current chat/session plan.

- Markdown checklist editor powered by a minimal CodeMirror instance.
- Persists the plan per `chat_jid` in Piclaw's extension KV store.
- Survives browser refreshes and follows the active web chat/session.
- Provides a `plan` tool with `get` and `set` actions so the model can inspect or update the same session plan.
- Includes a **Submit to model** button that saves the sidebar content and sends it back into the current session as an agent message.

## Tool

```json
{ "action": "get" }
```

```json
{ "action": "set", "markdown": "- [ ] Verify build\n- [ ] Report back" }
```

By default the tool uses the active chat/session. Pass `chat_jid` only when intentionally reading or writing another session.
