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
| RC-5 | Recover safely | Reload and restart the host with discussions, drafts and receipts intact. No surprise send, deleted-content resurrection or recurring idle scans. Retain the add-on store on removal/reinstall. | partial |
| RC-6 | Ship a compatible package | Verify the packed add-on in a disposable Classic host; pass regression/typecheck/catalogue and hosted CI; use the correct core compatibility version and an approved rollback/deployment path. | blocked |

`partial` means useful checks have passed but the whole row has not been signed
off. `blocked` means a known dependency prevents sign-off. Neither is a pass.
Record a pass only with concrete results for the required behaviour. Test counts
and references to old scenario IDs do not change status automatically.

## What is left

- **RC-4:** [CR-079](CR-079-HOST-CONTRACT.md) needs a host-verified per-prompt
  dispatch reference. Caller-supplied IDs cannot replace it. Core changes require
  approval; this security boundary is still a release blocker.
- **RC-6:** integrate/review the core contract, settle compatibility and catalogue
  metadata, obtain hosted CI, and get approval for publication/merge/deployment.
- **RC-1/2/3/5:** consolidate the existing results into these flows and finish the
  mock comparison and missing lifecycle/recovery assertions. The
  [evidence ledger](CLASSIC-FAST-PASS.md) records tested slices. The all-options
  packed host run now passes after correcting the replacement page's history
  prompt handler and request observation on fixture restart.

### Mock comparison findings

The source-level comparison of `review-pane-mock.html` with `web/pane.ts` and
`web/styles.ts` found these remaining differences; visual comparison is still due:

- **RC-1:** the implementation's timestamped snapshot picker and overflow capture
  actions differ from the mock's source-mode selector. File rows lack the mock's
  additions/deletions and open-concern counts.
- **RC-2:** collapsed threads and the Threads drawer lack the mock's author,
  first-message summary, file-path and per-thread delivery cues. Resolution
  evidence needs a clearer visible presentation.
- **RC-3:** mixed-target selection now opens the send drawer with the mock's
  explicit reassignment/separate-batches warning and disabled confirmation.
  Removing the mismatched item still requires a fresh preview. Browser tests
  confirm that neither this warning nor selection changes reassign or queue work.

The implementation already uses pane-width responsiveness, 12px/18px code rows,
unified/split views and 32px SVG icon controls. These code matches are not a visual
parity pass. Keep the approved mock unchanged while correcting the implementation.

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
