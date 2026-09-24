# Code Review — Gherkin acceptance index

Draft acceptance specification, 23 September 2026. **184 scenarios in 12 feature
files; 917 scenario steps plus 26 background steps.** IDs CR-001–CR-184 are stable
and complete. No implementation or executed behaviour tests are claimed.

## Reading and test conventions

- Start with the workflow files, then the focused pane/rendering/host/data contracts.
- CR-001–CR-121 preserve the existing workflow IDs. CR-114/CR-117 intentionally
  specify absence of Viewed, superseding earlier mock revisions.
- A `.feature` file is the source of each scenario. The downloadable combined
  Markdown is generated from those files and must not be edited independently.
- Only Feature, Background, Scenario, tags and simple Given/When/Then/And/But are
  used. No outlines, tables or placeholder step definitions.
- Pixel sizing uses CSS pixels at 100% browser zoom and standard host font settings.
  Test actual pane width, not just window width; user zoom remains respected.
- Numeric file/comment/pagination limits in README are proposed configuration
  defaults. Tests that reference a configured limit set it explicitly.
- Persistent-state claims require real file-backed disposable storage and restart
  tests; host claims require actual supported contracts on a disposable instance.
- Fake deterministic agent fixtures may exercise queue/response states, but cannot
  substitute for host authority, routing or source assertions.
- The static mock illustrates appearance. Its memory-only storage, synthetic queue
  feedback, precomputed highlighting and no-op refresh are not acceptance results.
- No real credentials, live browser target, core DB reset or project source mutation
  is permitted as an implicit test fixture.

## Coverage map

- **Explorer entry for any saved file, normal editor untouched:** CR-001–CR-011, CR-111–CR-115, CR-155–CR-158.
- **Read-only source, staged/unstaged/commit comparisons, line and range comments:** CR-004–CR-016, CR-091–CR-092, CR-129–CR-134.
- **Persistent comment/reply CRUD, drafts and deletion:** CR-017–CR-032, CR-065–CR-076, CR-093–CR-096, CR-167–CR-174.
- **Explicit individual/batch sends, default target picker, queue not interrupt:** CR-033–CR-045, CR-097–CR-110, CR-125, CR-141, CR-162–CR-164, CR-175–CR-180.
- **Agent resolution, user reopening, stale anchors and changing source:** CR-046–CR-064, CR-103, CR-169–CR-172, CR-179–CR-180.
- **Compact toolbar, source rows, layout and Settings action controls:** CR-122–CR-141, CR-142, CR-154.
- **Current Piclaw theme, fixed green/red washes and syntax roles:** CR-119–CR-121, CR-143–CR-153.
- **Native browser title tooltips; Include in send only; no Viewed:** CR-114, CR-116–CR-118, CR-127, CR-140, CR-184.
- **Authenticated host APIs, stable local identity, popout and lifecycle:** CR-077–CR-090, CR-155–CR-166, CR-178.
- **Add-on-owned SQLite, immutable captures, transaction/idempotency/recovery:** CR-064–CR-076, CR-097–CR-110, CR-167–CR-184.

## Feature and scenario index

### [01-pane-and-sources.feature](features/01-pane-and-sources.feature)

18 scenarios; 90 scenario steps.

- **CR-001** — Open review without replacing the normal editor
- **CR-002** — Reopen an existing review from a durable link
- **CR-003** — Review saved content without Git
- **CR-004** — Source review has no editing or buffer-save workflow
- **CR-005** — Review a newer saved revision after agent changes
- **CR-006** — Distinguish simultaneous staged and unstaged changes
- **CR-007** — Annotate untracked and deleted files
- **CR-008** — Inspect a recent committed change without changing checkout
- **CR-009** — Require an explicit merge parent
- **CR-010** — Handle root commits and empty diffs honestly
- **CR-011** — Preserve review access when source cannot be displayed
- **CR-091** — Browse recent changes in a bounded file history
- **CR-092** — Reopen the exact historical comparison
- **CR-111** — Start a file review from the explorer without changes or an editor tab
- **CR-112** — Review a Git-less explorer file directly
- **CR-113** — Keep ordinary explorer opening separate from review
- **CR-114** — File navigation requires no reading-progress bookkeeping
- **CR-115** — Explorer review is available without hover or right-click

### [02-annotations-and-drafts.feature](features/02-annotations-and-drafts.feature)

12 scenarios; 53 scenario steps.

- **CR-012** — Create a line comment
- **CR-013** — Create a contiguous range comment
- **CR-014** — Create file-level guidance without inventing a line
- **CR-015** — Comment separately on old and new diff lines
- **CR-016** — Do not create an ambiguous cross-side range
- **CR-017** — Preserve a draft across normal navigation
- **CR-018** — Warn before discarding an unpersisted draft
- **CR-019** — Empty and oversized comments are not silently accepted
- **CR-020** — Retry after an uncertain post does not duplicate a thread
- **CR-021** — Keep comments visible when filtering changes
- **CR-093** — Recover an acknowledged unpublished draft after restart
- **CR-094** — Do not promise recovery of unacknowledged offline keystrokes

### [03-comment-management.feature](features/03-comment-management.feature)

13 scenarios; 57 scenario steps.

- **CR-022** — Edit my published comment
- **CR-023** — Cancel an edit
- **CR-024** — Refuse a conflicting stale edit
- **CR-025** — Delete my comment while preserving replies
- **CR-026** — Cancel a destructive action
- **CR-027** — Delete an entire discussion explicitly
- **CR-028** — Editing or deleting dispatched guidance cannot recall it
- **CR-029** — Preserve authorship boundaries
- **CR-030** — Agent correction retains its reply identity
- **CR-031** — Deletion wins over a late retry
- **CR-032** — A late reply cannot resurrect a deleted thread
- **CR-095** — Edit and delete my own threaded reply
- **CR-096** — Agent may delete its own reply without rewriting user guidance

### [04-threaded-agent-work.feature](features/04-threaded-agent-work.feature)

26 scenarios; 138 scenario steps.

- **CR-033** — Dispatch one saved thread explicitly
- **CR-034** — Queue guidance behind a busy target's current work
- **CR-035** — Agent reads current guidance before acting
- **CR-036** — Persist an agent reply in the annotation thread
- **CR-037** — Hold a multi-turn clarification conversation
- **CR-038** — Post a reply without starting execution
- **CR-039** — Report blocked work without resolving the concern
- **CR-040** — A failed queue submission preserves the discussion
- **CR-041** — Reconcile an ambiguous delivery instead of replaying it
- **CR-042** — Changing instructions invalidates an old resolution attempt
- **CR-043** — Explicit reassignment preserves the conversation
- **CR-044** — Distinguish session rotation from a different agent target
- **CR-045** — Show agent progress without storing private reasoning
- **CR-097** — Double send reuses one durable dispatch intent
- **CR-098** — Retry a definitively rejected dispatch with a correlated attempt
- **CR-099** — Review defaults apply only to future thread assignments
- **CR-100** — Reused aliases cannot redirect an existing thread silently
- **CR-101** — Deleting a thread retains a body-free work receipt
- **CR-102** — Resolving a thread does not imply cancelling its active turn
- **CR-104** — Send selected comments across files as one review
- **CR-105** — Keep batch replies and outcomes attached to individual threads
- **CR-106** — Reject a changed batch selection before any dispatch
- **CR-107** — Require one valid target for a batch
- **CR-108** — Reject an out-of-scope batch item without partially sending valid items
- **CR-109** — Repeated batch sends reuse the intent and its frozen selection
- **CR-110** — Recheck changed items when a queued batch begins

### [05-resolution.feature](features/05-resolution.feature)

9 scenarios; 40 scenario steps.

- **CR-046** — Agent resolves after addressing the current concern
- **CR-047** — Explanation required even when no code change is appropriate
- **CR-048** — Source edits alone never resolve comments
- **CR-049** — User resolves a concern without an agent run
- **CR-050** — Reopen and continue the same conversation
- **CR-051** — Inspect the code revision associated with a resolution
- **CR-052** — Reject a resolve racing a new user reply
- **CR-053** — Replying to resolved work is an explicit reopening choice
- **CR-054** — Open and resolved counts reflect committed state

### [06-changing-source.feature](features/06-changing-source.feature)

11 scenarios; 52 scenario steps.

- **CR-055** — Refresh after unrelated lines are inserted
- **CR-056** — Changed anchored text is shown as outdated
- **CR-057** — Repeated code creates ambiguity rather than a false match
- **CR-058** — Explicitly re-anchor with visible provenance
- **CR-059** — Follow only a verified rename
- **CR-060** — Preserve a thread when a file is deleted and recreated
- **CR-061** — A changing diff cannot mix revisions in one snapshot
- **CR-062** — Changing diff mode does not move earlier comments
- **CR-063** — Do not overwrite a typed reply during source refresh
- **CR-064** — Keep linked worktrees and repositories separate
- **CR-103** — Moving a resolved concern requires explicit reopen

### [07-durability-and-concurrency.feature](features/07-durability-and-concurrency.feature)

12 scenarios; 52 scenario steps.

- **CR-065** — Browser reload restores the review
- **CR-066** — Process restart preserves history without replaying work
- **CR-067** — Reinstall retains durable reviews
- **CR-068** — Save failure does not discard a comment draft
- **CR-069** — Browser disconnect after commit is idempotent
- **CR-070** — Different payloads cannot reuse an idempotency key
- **CR-071** — Concurrent replies retain a stable order
- **CR-072** — Delete and reply races are atomic
- **CR-073** — Preserve source files while managing reviews
- **CR-074** — Paginate long discussions without losing context
- **CR-075** — Dispose the pane without leaking background work
- **CR-076** — Reconnect after missed events from durable state

### [08-security-and-accessibility.feature](features/08-security-and-accessibility.feature)

20 scenarios; 87 scenario steps.

- **CR-077** — Reject unauthenticated and cross-origin mutation
- **CR-078** — Author and target identities come from trusted context
- **CR-079** — Guessing IDs cannot cross review boundaries
- **CR-080** — Deny unsupported family or remote exposure
- **CR-081** — Reject workspace escapes and hostile Git arguments
- **CR-082** — Treat document and comment contents as untrusted text
- **CR-083** — Bound source and comment reads honestly
- **CR-084** — Review content is not sent to external services by opening a pane
- **CR-085** — Keyboard users can annotate and converse
- **CR-086** — Tablet users can target a precise range
- **CR-087** — Classic retains usable narrow layouts
- **CR-088** — Preserve draft safety on Escape and tab close
- **CR-089** — Keep idle work bounded
- **CR-090** — Export and clipboard actions do not leak by implication
- **CR-116** — Every control has native helper text
- **CR-117** — Thread checkboxes have only dispatch-selection meaning
- **CR-118** — Disabled action helper text explains the current blocker
- **CR-119** — Highlight complete snapshots without mixing diff sides
- **CR-120** — Syntax colours follow Piclaw without erasing diff tints
- **CR-121** — Highlighting fails safely to escaped source

### [09-pane-layout-and-controls.feature](features/09-pane-layout-and-controls.feature)

20 scenarios; 114 scenario steps.

- **CR-122** — Keep the desktop review toolbar to one purposeful row
- **CR-123** — Place file identity beside the code rather than repeating it above
- **CR-124** — Put secondary display actions in a dismissible View options menu
- **CR-125** — Send reports only the current explicit selection
- **CR-126** — Use a file rail only when the review needs one
- **CR-127** — Navigate a changed-file rail without reading-progress state
- **CR-128** — Restore file-local navigation and comment drafts
- **CR-129** — Distinguish file mode from an explicit comparison
- **CR-130** — Switch unified and split views without changing the comparison
- **CR-131** — Expand context without losing immutable line coordinates
- **CR-132** — Wrap long source lines without altering their content
- **CR-133** — Show discussions immediately beside their cited code
- **CR-134** — Collapse threads without hiding unresolved work
- **CR-135** — Use the thread drawer to find current and outdated concerns
- **CR-136** — Adapt to pane width rather than browser width
- **CR-137** — Keep narrow controls reachable without inflating code rows
- **CR-138** — Match Classic Settings and Add-ons action-button appearance
- **CR-139** — Keep icon controls consistent without duplicating the tab close action
- **CR-140** — Keep control help meaningful after updates
- **CR-141** — Present queue feedback only after an actual send attempt

### [10-theme-and-source-rendering.feature](features/10-theme-and-source-rendering.feature)

13 scenarios; 73 scenario steps.

- **CR-142** — Keep source rows compact in every layout
- **CR-143** — Honour the active host theme over the operating-system preference
- **CR-144** — Apply theme and custom-tint changes without rebuilding the review
- **CR-145** — Tint the current code background green and red
- **CR-146** — Preserve diff meaning when host semantic colours are monochrome
- **CR-147** — Render syntax through Piclaw token roles
- **CR-148** — Tokenise old and new documents before slicing diff lines
- **CR-149** — Syntax rendering preserves exact text and anchor coordinates
- **CR-150** — Fall back without making unsupported files unreviewable
- **CR-151** — Separate the highlighting limit from the review-file limit
- **CR-152** — Reject stale highlighting after changing snapshots
- **CR-153** — Markdown and plain text remain source reviews
- **CR-154** — Browser zoom and forced colours preserve controls and diff labels

### [11-host-integration.feature](features/11-host-integration.feature)

12 scenarios; 65 scenario steps.

- **CR-155** — Register an explicit explorer action without taking over file opening
- **CR-156** — Route review IDs through the pane registry
- **CR-157** — Fail closed when a required host contract is missing
- **CR-158** — Handle an unavailable add-on behind a saved review tab
- **CR-159** — Pop out and reattach without copying review ownership into the URL
- **CR-160** — Distinguish comment draft dirtiness from source editing
- **CR-161** — Switching reviews does not leave hidden work scanning source
- **CR-162** — Treat the opening chat as a suggestion rather than identity proof
- **CR-163** — Use authenticated add-on actions and the same service as agent tools
- **CR-164** — Deliver one local instruction through the normal queue
- **CR-165** — Recover updates from records rather than trusting transient notifications
- **CR-166** — Keep source review independent of cloud review services

### [12-addon-data-contracts.feature](features/12-addon-data-contracts.feature)

18 scenarios; 96 scenario steps.

- **CR-167** — Keep durable review data in the scoped add-on store
- **CR-168** — Review identity survives path changes without creating accidental duplicates
- **CR-169** — Persist immutable source captures and comparison membership
- **CR-170** — Keep content identity exact while bounding stored source
- **CR-171** — Preserve immutable anchors alongside later projections
- **CR-172** — Version discussion messages without changing their identities
- **CR-173** — Deleted bodies cannot survive in normal retrieval shortcuts
- **CR-174** — Keep private drafts separate from published guidance
- **CR-175** — Retain a fixed batch selection with independent item results
- **CR-176** — Claim delivery once across concurrent workers and restart
- **CR-177** — Preserve request idempotency without replaying deleted content
- **CR-178** — Bind local agents across context rotation but not alias reuse
- **CR-179** — Store resolution evidence against the version actually addressed
- **CR-180** — Keep thread delivery and work states independent
- **CR-181** — Failed schema migration preserves the existing review database
- **CR-182** — Restore review records without binding them to an unrelated workspace
- **CR-183** — Reference validation rejects cross-review and dangling records atomically
- **CR-184** — Store only review state that serves the agreed workflow

## Validation

Parsed with `@cucumber/gherkin@41.0.0` and the repository’s read-only extracted
`parseFeature`. Scenario names and step text agree, all IDs are unique and every
scenario has an action and outcome. This validates syntax and structure only.
The delegated consistency check timed out; no independent review result is claimed.
