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
insufficient. Any intentional UX deviation needs Rui's approval. Full mockup
parity has not yet been verified. Mock-only persistence and agent simulation are
replaced by the real implementation, not copied as backend behaviour.

## Six checks

| ID | Check | Required result | Status |
| --- | --- | --- | --- |
| RC-1 | Read code | Match the mock's Classic source/diff layout and controls. Open files and Git history; paginate/copy without source changes. Keyboard and phone entry work; oversize input is rejected clearly. | partial |
| RC-2 | Discuss changes | Match the mock's inline discussions and draft interactions. Create/reply/edit/delete/resolve/reopen; preserve private drafts and original anchors, refresh changed source and reject stale updates. | partial |
| RC-3 | Send work | Match the mock's selection, send preview and status feedback. Only explicit single/batch Send queues work; respect busy targets, deduplicate retries and distinguish accepted/completed/unknown outcomes without replay. | partial |
| RC-4 | Enforce permissions | Reject anonymous, cross-origin, forged-identity and unsafe-path requests; render untrusted text safely. A prompt for one review cannot read or mutate another review in the same chat. | blocked |
| RC-5 | Recover safely | Reload and restart the host with discussions, drafts and receipts intact. No surprise send, deleted-content resurrection or recurring idle scans. Retain the add-on store on removal/reinstall. | passed |
| RC-6 | Ship a compatible package | Verify the packed add-on in a disposable Classic host; pass regression/typecheck/catalogue and hosted CI; use the correct core compatibility version and an approved rollback/deployment path. | blocked |

`partial` means useful checks have passed but the whole row has not been signed
off. `blocked` means a known dependency prevents sign-off. Neither is a pass.
Record a pass only with concrete results for the required behaviour. Test counts
and references to old scenario IDs do not change status automatically.

## What is left

- **RC-4:** [CR-079](CR-079-HOST-CONTRACT.md) needs a host-verified per-prompt
  dispatch reference. Caller-supplied IDs cannot replace it. Core changes require
  approval; this security boundary is still a release blocker.
- **RC-6:** integrate/review the core contract, settle compatibility, obtain hosted
  CI, and get approval for publication/merge/deployment. Local catalogue/root
  metadata now includes version 0.1.1 and `check:catalog` passes; nothing is published.
- **RC-1/2/3:** finish the mock comparison and approve or correct presentation
  differences. RC-5 passes the supported Classic recovery flow below. The
  [evidence ledger](CLASSIC-FAST-PASS.md) records tested slices. The all-options
  packed host run now passes after correcting the replacement page's history
  prompt handler and request observation on fixture restart.

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
owned loopback catalogue and the packed 0.1.1 add-on. It verifies the same retained
data after reinstall and passes alongside phone/source/copy and a 65-second idle
check (259 assertions). This closes RC-5 for the supported local Classic flow;
public catalogue deployment and other platform permutations are not tested.
The absent add-on currently returns a guarded
500 from the host's legacy unknown-command fallback, not a missing-route 404.

These checks narrow the remaining work; they do not approve the UX differences
or satisfy the per-prompt security boundary.

### Mock comparison findings

The batched correction now has browser measurements and paired screenshots in
`exports/code-review-mock-comparison/` (workspace-relative). These remain review
evidence; full visual sign-off is open.

- **RC-1:** source modes are in the toolbar; immutable snapshot history stays in
  the file header. File rows show additions/deletions/open counts and an open-only
  filter. Unified diffs show both old/new line numbers. Git-less files disable
  Git modes, and an in-flight source capture disables the mode selector.
- **RC-2:** public summaries include author, path and current delivery/work state;
  the drawer uses readable selection cards. Author Edit/Delete actions now sit in
  the overflow disclosure required by PANE-DESIGN.md, with 32px geometry, keyboard
  activation, Escape/focus restoration, confirmed deletion and no implicit send.
  Fresh discussion screenshots are in `exports/code-review-message-actions/`. Resolution evidence is visible with
  safe links. Summaries exclude drafts and deleted bodies and are bounded to 240
  characters. Metadata tests cover edits, deletes, owner/workspace checks and
  assignment epochs.
- **RC-3:** mixed-target selection now opens the send drawer with the mock's
  explicit reassignment/separate-batches warning and disabled confirmation.
  Removing the mismatched item still requires a fresh preview. Browser tests
  confirm that neither this warning nor selection changes reassign or queue work.

Measured against the mock with matching palette/fixtures: both use 12px/18px code
rows with zero vertical padding; desktop toolbars are both 45px, narrow toolbars
79px versus 78px at 520px, with no document overflow. The browser comparison also
checks source/send/diff states and displayed resolution evidence.

Presentation still needs approval: the mock expands discussions by default while
the implementation loads full conversations on demand; saved-snapshot navigation,
thread filters, expandable version references and explicit Refresh preview are
additional production controls. The mock's synthetic warning is intentionally
absent. Do not change the approved mock to conceal these differences.

## Deferred depth

The exhaustive theme/grammar/device/platform combinations, screen-reader audit,
multi-hour stress, every rename/merge race, old-schema migration and cross-machine
restore are follow-up work. They are not independent first-release gates and are
not claimed as supported or verified here. The agreed mock's UX is not deferred.
Supported-path security, data-loss and accidental-dispatch failures still block
the relevant row. Unsupported inputs must
fail safely. This scope change does not authorise core edits, publishing, merging,
live installation or restart.

Report progress as these six checks, not “180 scenarios remaining”.
