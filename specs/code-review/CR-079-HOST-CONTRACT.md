# CR-079: verified dispatch scope for Classic Code Review

**Status:** approval required for the separately owned Piclaw core worktree. No live deployment or core change is authorised by this note.

## Present gap

`runtime/src/addons/local-dispatch.ts` verifies a persisted queue message against a host-generated `addon_local_dispatch` marker, its chat, content digest and message ID. `runtime/src/addons/local-context.ts` consumes that admission once for a prompt and exposes the verified chat ID and incarnation. It does **not** expose which add-on dispatch started that prompt.

`addons/code-review/store.ts` therefore authorises an agent thread by owner, workspace and assigned chat/incarnation. Two reviews sent to the same chat can both be read in a prompt started by either dispatch. A `dispatchId` supplied in the tool arguments, or parsed from the queued text, cannot establish authority. The current CR-079 requirement cannot pass.

## Proposed minimal host contract (requires core-owner approval)

1. Extend the operator-only `localContext.enqueue` request with a bounded, structured, add-on-owned intent reference, e.g. `{ addonId: "code-review", intentId: dispatchId }`. Validate the reference and bind it **inside the guarded enqueue path** to the host-generated dispatch authority record, alongside the existing chat, content digest and eventual persisted message ID. Never derive it from public message blocks, prompt text or tool parameters.
2. After verifying the persisted message and consuming prompt admission, expose the immutable reference on `getToolContext()` for that prompt only. Keep it unavailable in unprovenanced, scheduled, remote, nested and subsequent ordinary prompts; revoke it with the current active agent scope. Preserve message-ID/content/chat-incarnation replay checks.
3. In Code Review, require `addonId === "code-review"`; look up `intentId` as the current accepted/attempting/unknown dispatch in the same owner/workspace and current chat/incarnation. Scope every agent read and mutation to that dispatch's selected thread IDs and saved file IDs, rechecking current assignment epoch, thread state and version. The `dispatchId` argument selects a record but never grants access. Keep operator reads unchanged.
4. Exercise two separately dispatched reviews assigned to one chat: a prompt admitted for R1 cannot list/read/reply/resolve/work on R2, even with guessed IDs, nor use an R2 parent or snapshot. A later R2 prompt can act on R2. Include rejected/rotated/deleted targets, forged wire blocks, replay and nested-turn negatives, and the existing real Classic local-provider flow.

A release cannot claim CR-079 acceptance from chat-incarnation checks alone. This change belongs to the core contract owner and needs review before any integration or compatibility-version update.
