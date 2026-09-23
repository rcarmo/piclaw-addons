@code-review @draft @pane-ux
Feature: Review code in a compact Piclaw pane with familiar controls
  These scenarios describe the real pane, not the synthetic HTML shell.
  CSS-pixel measurements use 100 percent browser zoom and the standard host font setting.

  Background:
    Given an authenticated operator opened a saved-code review in a disposable Piclaw workspace
    And the host owns the surrounding tabs, explorer, splitters and chat surface

  Scenario: CR-122 Keep the desktop review toolbar to one purposeful row
    Given the review pane has at least 1100 CSS pixels of available width
    When its initial toolbar is rendered
    Then the toolbar is at most 46 CSS pixels high
    And it contains the comparison selector, local-agent target, Threads, Send to agent and View options
    And it does not repeat the review tab title, a review subtitle or a Read-only badge
    And no permanent Queue badge or empty delivery status row consumes source space

  Scenario: CR-123 Place file identity beside the code rather than repeating it above
    When I select a file or a different saved comparison
    Then its filename and source revision or exact comparison appear together in the file header
    And the file header stays visible while I scroll that file's code
    And Git-less files identify saved content without implying a repository or commit
    And the tab title continues to identify the review independently of that header

  Scenario: CR-124 Put secondary display actions in a dismissible View options menu
    When I open View options using its labelled overflow icon
    Then Refresh saved source, Wrap long lines and Split or Unified diff are available there
    And unavailable actions are disabled with a native title explaining why
    When I press Escape
    Then the menu closes and focus returns to its trigger without changing source or selection
    And clicking outside the menu also dismisses it without activating an action

  Scenario: CR-125 Send reports only the current explicit selection
    Given no thread is selected for sending
    When I inspect Send to agent
    Then it is disabled with a title explaining how to include threads
    And its label does not show an unnecessary zero count
    When I include two eligible threads without submitting them
    Then its label shows a count of two and it opens a submission preview rather than queueing work

  Scenario: CR-126 Use a file rail only when the review needs one
    Given I opened one saved file from the explorer
    When the review first renders
    Then the file rail is collapsed and code uses the available width
    When I explicitly add another authorised saved file to the same review
    Then both files belong to that review and can be reached through its file rail
    And selecting an unrelated explorer file alone does not add it to this review

  Scenario: CR-127 Navigate a changed-file rail without reading-progress state
    Given the review compares several changed files
    When I inspect the file rail
    Then it lists each path, change type, addition and deletion counts, and open-thread count
    And there are no Viewed checkboxes or unread-file progress requirements
    When I filter by path or unresolved concerns
    Then only matching rows are shown without deleting hidden files or discussions

  Scenario: CR-128 Restore file-local navigation and comment drafts
    Given I scrolled file A and have an acknowledged comment draft on its saved range
    When I navigate to file B and then back to file A
    Then file A restores its scroll position, selected range and draft against the same snapshot
    And only the selected file's source needs to be mounted
    And navigation neither dispatches comments nor changes their original anchors

  Scenario: CR-129 Distinguish file mode from an explicit comparison
    Given a saved-file review has comments on snapshot S1
    When I choose a staged, unstaged or committed comparison that is available for that file
    Then the pane shows the selected old and new revisions and labelled sides
    And source-only comments remain tied to S1 unless a verified projection exists
    And returning to saved-file mode does not invent a second diff side

  Scenario: CR-130 Switch unified and split views without changing the comparison
    Given the pane has sufficient width for a split diff
    When I choose Split diff and then Unified diff
    Then both layouts show the same old and new snapshots and change classifications
    And split rows keep old and new line coordinates distinct
    And comments remain attached to the same side and range rather than to visual row indices
    And no file read or write changes the selected comparison as a side effect

  Scenario: CR-131 Expand context without losing immutable line coordinates
    Given a captured diff contains collapsed unchanged context around a hunk
    When I expand that context
    Then additional lines come from the already selected source snapshots
    And original line numbers, diff sides and thread anchors stay unchanged
    And context expansion is bounded and does not switch to newer working-tree bytes

  Scenario: CR-132 Wrap long source lines without altering their content
    Given a saved source line contains long text, tabs and significant indentation
    When I enable visual wrapping
    Then the whole source line remains one logical line for range selection and comments
    And copying its code text preserves the original characters without inserted visual-wrap newlines
    When I disable wrapping
    Then horizontal scrolling is confined to the code area rather than the entire pane

  Scenario: CR-133 Show discussions immediately beside their cited code
    Given an open thread cites a range in the currently displayed snapshot
    When I expand that thread
    Then its discussion appears below the range's final line in file or unified view
    And split view places the discussion below the corresponding paired row with its cited side visible
    And the discussion is rendered once rather than copied into both diff sides
    And unrelated code remains selectable and copyable

  Scenario: CR-134 Collapse threads without hiding unresolved work
    Given an expanded thread has public replies and a recorded resolution or open concern
    When I collapse it
    Then a compact row retains its author, guidance snippet and thread state
    And a resolved thread exposes its explanation and evidence again when expanded
    And collapse changes only presentation, not delivery state, discussion history or resolution

  Scenario: CR-135 Use the thread drawer to find current and outdated concerns
    Given a review contains unsent, open, resolved and outdated discussions across files
    When I open Threads and select a discussion
    Then the drawer can filter those categories and show the chosen thread's file and anchor
    And a current thread is revealed at its range while an outdated thread shows its original context
    And opening or navigating the drawer does not submit a review
    And the drawer is not a permanently reserved third code column

  Scenario: CR-136 Adapt to pane width rather than browser width
    Given a desktop browser contains a review pane narrowed by Piclaw's splitter
    When that pane crosses below 1100 CSS pixels of available width
    Then the file rail becomes a Files affordance and split view yields to unified view
    And the review drawer overlays content instead of squeezing another permanent column beside it
    And the selected comparison, thread IDs and draft stay intact

  Scenario: CR-137 Keep narrow controls reachable without inflating code rows
    Given the review pane is narrower than 720 CSS pixels
    When I use its toolbar, file picker, thread drawer and comment composer
    Then the toolbar wraps and drawers fit the pane without horizontal shell overflow
    And Close, Cancel, Post and Send remain reachable when the on-screen keyboard is open
    And source remains selectable through keyboard or explicit range controls without requiring hover
    And compact source rows do not inherit large toolbar-button minimum heights

  Scenario: CR-138 Match Settings and Add-ons action-button appearance in each skin
    Given reference secondary, primary and danger actions render in the active skin's Settings add-on surface
    When equivalent review actions render and enter hover, focus-visible or disabled states
    Then their font, padding, border, radius, theme colours and state styling match those host controls
    And Classic and Visual retain their respective sizing and typography contracts
    And primary text uses the host accent-contrast foreground
    And ordinary Reply, Resolve, Post and Send actions do not use unrelated compact or link variants

  Scenario: CR-139 Keep icon controls consistent without duplicating the tab close action
    When file-drawer Close, thread-drawer Close and View options icons are visible
    Then each has a 32 CSS pixel square box with a centred SVG glyph
    And Close uses the host tab-strip X shape rather than a typographic multiplication sign
    And each icon has an accessible name, native title and visible keyboard focus
    And the persistent desktop file rail has no unnecessary drawer Close control
    And Piclaw's tab strip remains the sole owner of the review tab's close button

  Scenario: CR-140 Keep control help meaningful after updates
    Given a send changes from selectable to queued or becomes blocked by target mismatch
    When the pane rerenders the affected buttons and Include in send checkboxes
    Then their native title text describes the current purpose or blocker and any execution side effect
    And no control relies solely on an unexplained icon or a checkbox beside an Open status label
    And no custom tooltip overlay or tap-to-help behaviour is introduced

  Scenario: CR-141 Present queue feedback only after an actual send attempt
    Given selected guidance is ready but has not been submitted
    When I inspect the review pane
    Then ordinary source space is not occupied by an idle queue-status row
    When I explicitly submit it and receive a delivery result
    Then a compact status identifies the target and queued, rejected or unknown result as applicable
    And the submission preview explains queue-behind-current-work before confirmation
    And accepted queue status never claims that code was fixed or comments were resolved
