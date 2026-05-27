# @rcarmo/piclaw-addon-goal

Codex-style persisted thread goals for Piclaw.

This add-on replaces the older prompt-template goal loop with a high-fidelity port of Codex CLI's goal model: a per-chat/thread goal record, Codex-compatible model tools, `/goal` user controls, budget accounting, and continuation/budget-limit prompts derived from Codex's upstream logic.

## Install

Open **Settings → Add-Ons** and install **goal** from the catalog.

## What it does

- stores one persisted thread goal per `chat_jid`
- exposes Codex-style tools:
  - `get_goal`
  - `create_goal`
  - `update_goal`
- adds `/goal` user controls for summary, create/replace, pause, resume, clear, and status
- tracks goal status, objective, token budget, tokens used, elapsed wall-clock time, created/updated timestamps, and goal id
- auto-continues active goals when the agent is idle and no user input is pending
- marks goals `budget_limited` when the configured token budget is exhausted and emits a Codex-style wrap-up prompt
- uses Codex's strict completion and blocked-audit prompt language
- integrates with `update_plan` when available, so multi-step goal turns can keep a live plan current
- provides a **Goal** settings pane for inspecting and editing the current thread goal

## `/goal` command

- `/goal` or `/goal status` — show the current goal state
- `/goal <objective>` — create a new active goal, or replace the current one after confirmation
- `/goal pause` or `/goal off` — pause the current goal
- `/goal resume` or `/goal on` — resume a paused/blocked/usage-limited/budget-limited goal as active and queue continuation
- `/goal clear` or `/goal reset` — clear the saved thread goal
- `/goal edit` — points to the Settings pane or replacement flow

## Tool contract

### `get_goal`

Read the current thread goal and usage state.

```json
{}
```

Returns:

```json
{
  "goal": {
    "threadId": "web:default",
    "goalId": "...",
    "objective": "Ship the feature",
    "status": "active",
    "tokenBudget": 100000,
    "tokensUsed": 1234,
    "timeUsedSeconds": 42,
    "createdAt": "2026-05-27T...Z",
    "updatedAt": "2026-05-27T...Z"
  },
  "remainingTokens": 98766,
  "completionBudgetReport": null
}
```

### `create_goal`

Create a new active goal only when explicitly requested. It fails if a goal already exists.

```json
{
  "objective": "Ship the feature",
  "token_budget": 100000
}
```

### `update_goal`

Only the model can use this to mark the existing goal terminal:

```json
{ "status": "complete", "summary": "Verified against tests and PR state." }
```

```json
{ "status": "blocked", "summary": "The same external service outage blocked three consecutive goal turns." }
```

`update_goal` intentionally cannot pause, resume, clear, budget-limit, or usage-limit a goal. Those status transitions are controlled by the user or runtime.

## Status model

The add-on uses Codex's status vocabulary:

| Status | Meaning |
|---|---|
| `active` | goal is live and auto-continuation can proceed |
| `paused` | user paused the goal |
| `blocked` | model verified the strict repeated-blocker audit |
| `usage_limited` | reserved for runtime usage-limit integration |
| `budget_limited` | token budget was exhausted |
| `complete` | model verified the objective is achieved |

## Settings pane

Open **Settings → Goal** to:

- inspect the current chat's thread goal
- edit/replace the objective
- set or clear the token budget
- pause, resume, mark blocked, mark complete, clear, or refresh the goal

The prompt templates are intentionally no longer editable. The add-on embeds Codex's goal prompt policy so behavior stays faithful to the upstream goal logic.

## Storage model

| What | Where |
|---|---|
| Current thread goal | Extension KV (`goal`, chat scope, key `thread-goal`) |
| Settings pane state | Browser state only |

## Notes

- Goal state is scoped to the current Piclaw chat/session (`chat_jid`).
- Token accounting uses assistant message usage from Piclaw events, then applies Codex-style budget-limit behavior.
- The continuation prompt treats the objective as untrusted user-provided task context and XML-escapes it before embedding.
- `update_plan` is not bundled in this add-on; it is supplied by the Plan Sidebar add-on. The goal prompt is written to use it when available.
