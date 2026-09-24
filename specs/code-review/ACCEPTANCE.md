# Classic Code Review — six release checks

This is the active release checklist, simplified at Rui's request on 24 September
2026. Visual is out of scope. The [184 older scenarios](SPEC-INDEX.md) are design
reference, not 184 required test runs. Keep the existing regression tests; reuse
their assertions and the disposable Classic host fixture across these six checks.

## UX stays as agreed

The [approved interactive mock](review-pane-mock.html) and
[pane design](PANE-DESIGN.md) define the Classic UX. Simplifying the tests does
not simplify or redesign the product. Preserve:

- Compact toolbar, collapsible file rail, dense code/diff rows and inline threads.
- Unified/split views, range selection, original-context navigation and responsive
  drawers that keep the source and conversation controls usable.
- Host theme tokens, syntax/diff colours, Settings-style buttons, consistent close
  icons, native helper titles and visible keyboard focus.
- Private drafts, explicit single/batch Send and distinct queued/resolved states;
  no Viewed checkbox or reading-progress workflow.

Before signing off RC-1–RC-3, compare the running Classic pane against the mock
in the same source/diff, discussion and send-preview states at desktop and narrow
widths. Keep visual and interaction comparison evidence; API success alone is
insufficient. Rui approved the closer-mock changes on 24 September: expand open
discussions, tuck secondary controls away and update the send preview automatically.
Those behaviours pass the browser comparison below. This is layout/interaction
acceptance, not a pixel-identical claim. Mock-only persistence and agent simulation
are replaced by the real implementation.

## Six checks

| ID | Check | Required result | Status |
| --- | --- | --- | --- |
| RC-1 | Read code | Match the mock's Classic source/diff layout and controls. Open files and Git history; paginate/copy without source changes. Keyboard and phone entry work; oversize input is rejected clearly. | passed |
| RC-2 | Discuss changes | Match the mock's inline discussions and draft interactions. Create/reply/edit/delete/resolve/reopen; preserve private drafts and original anchors, refresh changed source and reject stale updates. | passed |
| RC-3 | Send work | Match the mock's selection, send preview and status feedback. Only explicit single/batch Send queues work; respect busy targets, deduplicate retries and distinguish accepted/completed/unknown outcomes without replay. | passed |
| RC-4 | Enforce permissions | Reject anonymous, cross-origin, forged-identity and unsafe-path requests; render untrusted text safely. Each Send scopes review-tool access to its selected concerns, including multi-file batches, independently of other Sends in the same review/chat. | passed |
| RC-5 | Recover safely | Reload and restart the host with discussions, drafts and receipts intact. No surprise send, deleted-content resurrection or recurring idle scans. Retain the add-on store on removal/reinstall. | passed |
| RC-6 | Ship a compatible package | Verify the packed add-on in a disposable Classic host; pass regression/typecheck/catalogue and hosted CI; use the correct core compatibility version and an approved rollback/deployment path. | blocked |

`partial` means useful checks have passed but the whole row has not been signed
off. `blocked` means a known dependency prevents sign-off. Neither is a pass.
Record a pass only with concrete results for the required behaviour. Test counts
and references to old scenario IDs do not change status automatically.

## What is left

- **RC-6:** core PR [piclaw#1407](https://github.com/rcarmo/piclaw/pull/1407) and
  draft add-on PR [piclaw-addons#144](https://github.com/rcarmo/piclaw-addons/pull/144)
  are pushed and pass hosted CI. Merge/release approval and the actual compatible
  core release version remain open. Catalogue metadata includes 0.1.2 and
  `check:catalog` passes; nothing is published. `>=3.2.1` is still provisional.
- RC-1–RC-5 pass on the owned Classic fixtures. The [evidence ledger](CLASSIC-FAST-PASS.md)
  records regression, browser and packed-host results. [Submission isolation](CR-079-HOST-CONTRACT.md)
  is implemented in both worktrees after approval and verified locally.

### Send and recovery follow-up

RC-3 now has a packed authenticated Classic check with an actual busy target:
hold an earlier loopback-provider turn, submit the review, observe an accepted
attempt with `not_started` work and an open thread, then release the earlier turn.
The review does not start or interrupt the held turn. It subsequently completes
once. Browser retry/reconcile and batch tests also pass; uncertain delivery is
not automatically replayed.

RC-5 now saves a draft through the real composer before cold shutdown. After a
boot with the package absent and another with it restored, the draft restores
through the pane. Exact message history, a deleted-reply tombstone, its body-free
receipt and the accepted/completed dispatch survive. The database and any WAL
bytes are unchanged during the package-absent boot. There are no extra provider
turns, dispatches or attempts. The later `PICLAW_REVIEW_CATALOG_TEST=1` run uses
the real authenticated catalogue-manager uninstall/install endpoints with an
owned loopback catalogue and the packed 0.1.2 add-on. It verifies the same retained
data after reinstall and passes alongside phone/source/copy and a 65-second idle
check (259 assertions). This closes RC-5 for the supported local Classic flow;
public catalogue deployment and other platform permutations are not tested.
The absent add-on currently returns a guarded
500 from the host's legacy unknown-command fallback, not a missing-route 404.

Submission isolation is covered by host provenance tests, add-on negative tests
and the real-host agent flow. A dedicated positive test sends concerns from two
files together, then reads, replies to and resolves both under that submission.

### Mock comparison findings

The current browser measurements and paired screenshots are in
`exports/code-review-mock-aligned/` (workspace-relative). The approved mock file
is unchanged. Earlier screenshot directories describe earlier checkpoints.

- **RC-1:** source modes are in the toolbar; immutable snapshot history is tucked
  into the closed Saved versions disclosure in the file header. File rows show additions/deletions/open counts and an open-only
  filter. Unified diffs show both old/new line numbers. Git-less files disable
  Git modes, and an in-flight source capture disables the mode selector.
- **RC-2:** public summaries include author, path and current delivery/work state;
  the drawer uses readable selection cards. Author Edit/Delete actions now sit in
  the overflow disclosure required by PANE-DESIGN.md, with 32px geometry, keyboard
  activation, Escape/focus restoration, confirmed deletion and no implicit send.
  Open discussions on the current source page expand automatically, loading at
  most four requests concurrently from the bounded 50-thread/300-line page.
  Explicitly collapsed and resolved discussions stay compact. Resolution evidence
  is visible with safe links. Summaries exclude drafts and deleted bodies and are bounded to 240
  characters. Metadata tests cover edits, deletes, owner/workspace checks and
  assignment epochs.
- **RC-3:** mixed-target selection now opens the send drawer with the mock's
  explicit reassignment/separate-batches warning and disabled confirmation.
  Removing the mismatched item updates the preview automatically. Thread filters
  and exact version references sit in disclosures. Final Send remains explicit.
  Stale preview responses cannot replace a newer selection or reopen a closed
  drawer. A rejected version conflict refreshes the preview and requires another
  explicit Send; unknown delivery is never retried automatically.

Measured against the mock with matching palette/fixtures: both use 12px/18px code
rows with zero vertical padding; desktop toolbars are both 45px, narrow toolbars
79px versus 78px at 520px, with no document overflow. The browser comparison also
checks source/send/diff states and displayed resolution evidence.

The default collapsed-discussion and manual-refresh differences described in the
earlier checkpoint have been corrected. An explicit Retry preview appears only
after a failed preview request; it is not part of the successful send flow.
The mock's synthetic warning is absent from the working pane.

## Deferred depth

The exhaustive theme/grammar/device/platform combinations, screen-reader audit,
multi-hour stress, every rename/merge race, old-schema migration and cross-machine
restore are follow-up work. They are not independent first-release gates and are
not claimed as supported or verified here. The agreed mock's UX is not deferred.
Supported-path security, data-loss and accidental-dispatch failures still block
the relevant row. Unsupported inputs must
fail safely. Rui separately approved core submission-isolation edits. Publishing,
merging, live installation and restart still require explicit permission.

Report progress as these six checks, not “180 scenarios remaining”.
