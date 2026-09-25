# Separate submissions in the same chat

Implemented locally after Rui's approval on 24 September 2026. Not installed or
published. Host changes are in `/workspace/piclaw-worktrees/addon-workspace-context`;
add-on changes are in the `feat/code-review` worktree.

## Behaviour

Each explicit Send creates one submission, containing one or many selected
concerns across files. The agent can read and address every selected concern.
A different Send has its own scope, even within the same review and agent chat.
This limits review-tool access; it does not sandbox the agent's normal file tools
or erase conversation history from earlier work.

## Host reference

Operator `localContext.enqueue` accepts optional `reference: {addonId, intentId}`.
For Code Review this is `{addonId: "code-review", intentId: dispatchId}`. The host
validates bounds and records it internally with the queued message's chat,
incarnation, content digest and eventual persisted message ID. Public content
blocks contain only a host-generated marker; public reference fields are ignored.

After verifying message admission, `getToolContext()` exposes the immutable
reference for that prompt. Ordinary, remote, nested or scheduled prompts do not
inherit it. Revocation and chat-lifetime checks still apply. Older consumers can
omit the reference, but Code Review agent calls require it.

## Add-on checks

`reviewAction` requires the verified Code Review reference and revalidates the
host context. The referenced dispatch must belong to the current owner/workspace
and agent chat/incarnation and have an attempting, accepted or unknown receipt.
Read/write actions are limited to its selected threads and saved file IDs;
assignment epochs, ownership and optimistic versions are checked again. Dispatch
listing returns only that submission. Caller-provided IDs select records but do
not grant access. Operator actions are unchanged.

The internal store still accepts trusted bare identities for lower-level callers;
these are not a browser/tool entry point. Public agent calls go through
`reviewAction` and reject missing references.

## Evidence

- Core local-context tests: same chat and identical prompt text with distinct
  submission references; forged wire data; frozen references; restart/replay
  binding; later ordinary prompt and revocation checks.
- `submission-isolation.test.ts`: separate concerns in the same review/chat,
  cross-review and guessed-ID denial, absent/wrong reference, old assignment,
  receipt reopen, and one multi-file batch whose selected concerns can all be
  read, replied to and resolved.
- `agent-start-acceptance.test.ts` and existing batch/reassignment tests preserve
  stale-source and per-item behaviour under the new scope.
- Packed authenticated Classic fixture completes real loopback-provider work with
  the verified host reference, including queue-behind-busy, restart and reinstall.

Core compatibility version, integration review and publication belong to RC-6.
