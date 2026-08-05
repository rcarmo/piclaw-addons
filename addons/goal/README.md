# @rcarmo/piclaw-addon-goal

Codex-style persisted thread goals for Piclaw.

Requires Piclaw `>=2.0.0`.

This add-on replaces the older prompt-template goal loop with a high-fidelity port of Codex CLI's goal model: a per-chat/thread goal record, Codex-compatible model tools, `/goal` user controls, budget accounting, and continuation/budget-limit prompts derived from Codex's upstream logic.

## Install

Open **Settings → Add-Ons** and install **goal** from the catalog.

## What it does

- stores one persisted thread goal per `chat_jid`
- exposes Codex-style tools:
  - `get_goal`
  - `create_goal`
  - `goal_complete`
  - `goal_stop`
  - `update_goal`
- adds `/goal` user controls for summary, create/replace, pause, resume, clear, and status
- tracks goal status, objective, token budget, tokens used, elapsed wall-clock time, created/updated timestamps, and goal id
- auto-continues active goals when the agent is idle and no user input is pending
- marks goals `budget_limited` when the configured token budget is exhausted and emits a Codex-style wrap-up prompt
- uses Codex's strict completion and blocked-audit prompt language
- injects a compact active-goal context block into ordinary user turns so agents know the current goal and terminal actions, not only during auto-continuation turns
- keeps Codex-compatible `update_goal({ status: "complete" })` as a first-class completion path while also offering evidence-rich `goal_complete`
- integrates with Plan Sidebar's `plan action=update` when available, so multi-step goal turns can keep a live plan current
- detects all-completed Plan Sidebar checklists and switches from normal continuation to a final completion audit
- auto-stops repeated completed-plan loops when completion is not verified
- auto-stops repeated unchanged incomplete-plan loops as `no_progress`
- provides a **Goal** settings pane for inspecting and editing the current thread goal

## `/goal` command

- `/goal` or `/goal help` — print the command list as a visible table plus the current goal status (also `?`, `commands`)
- `/goal status` — show the current goal state
- `/goal <objective>` — create a new active goal or immediately replace the current objective
- `/goal pause`, `/goal off`, or `/goal stop` — pause the current goal
- `/goal resume` or `/goal on` — resume a paused/blocked/usage-limited/budget-limited goal as active and queue continuation
- `/goal reset` or `/goal clear` — clear the saved thread goal (`clear` is an exact synonym for `reset`)
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
  "completionBudgetReport": null,
  "terminalGuidance": [
    "If the full objective is verified complete, finish the goal by calling goal_complete({ summary, evidence }) when available.",
    "Codex-compatible completion path: update_goal({ status: \"complete\", summary, evidence }) also marks the goal complete and should be used if goal_complete is unavailable or not selected."
  ]
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

### `goal_complete`

Preferred completion tool. Use only as the final action when the full objective is verified complete:

```json
{
  "summary": "Feature shipped and verified.",
  "evidence": ["bun test passed", "commit abc123 pushed", "microVM UI check passed"]
}
```

`goal_complete` records evidence and marks the goal `complete`. After it succeeds, the agent should send a concise final answer to the user instead of ending the turn with only the tool call.

### `goal_stop`

Stop the autonomous loop without marking the goal complete:

```json
{
  "reason": "plan_complete_unverified",
  "summary": "Plan is checked off but completion evidence is insufficient.",
  "evidence": ["all plan items completed", "missing deployment verification"]
}
```

Use this when completion is unverified, progress is stuck, user input is required, or external state blocks progress. It marks the goal `stopped`; after it succeeds, the agent should explain the stop to the user instead of ending the turn with only the tool call.

### `update_goal`

Codex-compatible terminal tool. Use this when following upstream Codex goal policy or when `goal_complete` is unavailable/not selected:

```json
{
  "status": "complete",
  "summary": "Verified against tests and PR state.",
  "evidence": ["bun test passed", "commit abc123 pushed"]
}
```

```json
{ "status": "blocked", "summary": "The same external service outage blocked three consecutive goal turns." }
```

Prefer `goal_complete` for verified completion when it is available because it requires evidence explicitly, but `update_goal({ "status": "complete" })` is intentionally kept as the Codex-compatible completion fallback. Both completion paths record terminal metadata and end the autonomous goal loop, but they deliberately do **not** early-terminate the Piclaw turn; the agent still needs to produce a user-facing final answer. `update_goal` intentionally cannot pause, resume, clear, budget-limit, stop, or usage-limit a goal. Those status transitions are controlled by the user, runtime, or `goal_stop`.

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
| `stopped` | autonomous loop was stopped without verified completion |

## Settings pane

Open **Settings → Goal** to:

- inspect the current chat's thread goal
- edit/replace the objective
- set or clear the token budget
- pause, resume, mark blocked, mark complete, clear, or refresh the goal

The pane uses `/agent/addons/api/goal/goal?chat_jid=...`. The add-on stores no secrets and does not use the keychain.

The prompt templates are intentionally no longer editable. The add-on embeds Codex's goal prompt policy so behaviour stays faithful to the upstream goal logic.

## Storage model

| What | Where |
|---|---|
| Current thread goal | Extension KV (`goal`, chat scope, key `thread-goal`) |
| Settings pane state | Browser state only |

## Notes

- Goal state is scoped to the current Piclaw chat/session (`chat_jid`).
- Token accounting uses assistant message usage from Piclaw events, then applies Codex-style budget-limit behavior.
- The continuation prompt and active-goal system prompt treat the objective as untrusted user-provided task context and XML-escape it before embedding.
- Ordinary user turns receive a compact `## Active Goal` system-prompt block with current status/budget and explicit terminal action guidance. This closes the gap where an agent could achieve a goal on a user-triggered turn but lack the goal context or completion instructions needed to stop.
- Goal completion/stop tools update persisted goal state but do not set Piclaw's early `terminate` hint. This prevents tool-only turns from completing without user-visible assistant output.
- Autonomous continuation, finalization, and budget-limit prompts are all dispatched through a single guarded path that re-checks the goal is still active and swallows transport failures, so a stale or failed dispatch cannot turn into an output-less turn or silently kill the loop.
- A turn that ends on a tool call (`stopReason` `toolUse`) is not treated as a failed turn. Only a **hard error** (`stopReason` `error` or an `errorMessage`) suppresses autonomous continuation.
- A turn aborted to trigger compaction (Piclaw's mid-turn tool-execution ceiling or context-pressure auto-compaction) is treated as a continuation boundary, not a failure. The assistant turn ends with `stopReason` `aborted` and the compaction is usually **deferred to the next prompt**, so no `session_compact` event fires that turn. Earlier versions tried to detect this via the `session_compact` event (0.1.34) and then a per-turn tool-activity signal (0.1.35), but **both proved unreliable in production**: tool-heavy goal turns kept dying on the bare `aborted` after a turn or a nudge — the main reason long unattended goals appeared to "stop soon after I leave the web UI". As of 0.1.37 the loop continues on **any non-errored outcome** (clean finish, tool-use finish, or bare `aborted`); only a hard error stops it. A user stop is rare for an autonomous goal and `/goal pause` is the intended stop control, and any spurious continuation is bounded by the `no_progress` auto-stop. An `agent_end` decision that skips continuation is logged to stderr with a `[goal-debug]` tag for diagnosis.
- The `no_progress` auto-stop keys on real tool activity, not just the Plan Sidebar text: substantive tool work (edits, bash, web, etc.) in a turn counts as progress even when the plan checklist is unchanged. Goal-internal tools (`get_goal`, `create_goal`, `goal_complete`, `goal_stop`, `update_goal`) do not count as progress.
- Plan storage is not bundled in this add-on; it is supplied by the Plan Sidebar add-on. The goal prompt is written to use `plan action=update` when available.
- When Plan Sidebar is installed, Goal reads its runtime API at `agent_end`. If every structured plan item is `completed`, Goal queues a finalization prompt instead of ordinary continuation. If the same completed plan remains unresolved after two probes, Goal marks the loop `stopped` with reason `plan_complete_unverified`.
- If Plan Sidebar is installed and an incomplete plan remains unchanged across three autonomous continuations, Goal marks the loop `stopped` with reason `no_progress` instead of continuing forever.
