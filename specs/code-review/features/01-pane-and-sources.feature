@code-review @draft
Feature: Open an explicit code review pane and choose source revisions
  Review saved code and diffs read-only, following a GitHub commit/PR review workflow.

  Background:
    Given Code Review is installed in a disposable single-operator Piclaw workspace
    And a local chat "Implementation" is available for assignment
    And a Git repository "app" contains saved file "src/main.ts"

  Scenario: CR-001 Open review without replacing the normal editor
    Given "src/main.ts" is open in the normal source editor
    When I explicitly open Code Review for "src/main.ts"
    Then a separate read-only review tab shows the saved source with line numbers
    And the normal source editor remains available with its content unchanged
    And the suggested agent target "Implementation" is visible but no work is queued

  Scenario: CR-002 Reopen an existing review from a durable link
    Given review "R1" contains an open discussion on "src/main.ts"
    And I closed its review tab
    When I open the durable link for review "R1"
    Then the same review and thread IDs are loaded
    And no duplicate review or discussion is created

  Scenario: CR-003 Review saved content without Git
    Given saved text file "notes/design.ts" is outside a Git repository
    When I explicitly open Code Review for "notes/design.ts"
    Then saved-source annotations are available
    And Git diff and commit selectors explain that Git history is unavailable
    And no repository is created automatically

  Scenario: CR-004 Source review has no editing or buffer-save workflow
    Given I am viewing saved source in Code Review
    When I focus the code area and attempt to type or paste replacement source
    Then the displayed source and saved file remain unchanged
    And source save controls and unsaved-buffer prompts are absent
    And I can still select source ranges and type guidance in a comment composer

  Scenario: CR-005 Review a newer saved revision after agent changes
    Given the agent saved changes to the reviewed file after my snapshot was captured
    When I refresh its code review
    Then the pane identifies the new saved content digest and capture time
    And earlier comments retain their original snapshot references

  Scenario: CR-006 Distinguish simultaneous staged and unstaged changes
    Given HEAD, the index and the working copy of "src/main.ts" all differ
    When I select "Unstaged changes"
    Then the old side is the index and the new side is the saved working copy
    When I select "Staged changes"
    Then the old side is HEAD and the new side is the index
    And both views display their distinct revision labels and changed-line numbers
    And reading either diff does not change the index or working tree

  Scenario: CR-007 Annotate untracked and deleted files
    Given "src/new.ts" is untracked and "src/old.ts" is deleted from the working tree
    When I review the working changes for these files
    Then "src/new.ts" can be compared with an empty old side
    And "src/old.ts" can be discussed on its retained old side
    And neither action stages or restores a file

  Scenario: CR-008 Inspect a recent committed change without changing checkout
    Given the repository has commits "C1" and "C2" with "C2" checked out
    When I select the diff of "C1" against its parent
    Then the pane displays the immutable selected commit pair
    And new comments anchor to that historical pair
    And HEAD, the index and the working tree remain unchanged

  Scenario: CR-009 Require an explicit merge parent
    Given commit "M1" has two parents
    When I choose to review commit "M1"
    Then the pane requires a parent selection before showing an annotated diff
    And the chosen parent remains visible with every comment made in that view

  Scenario: CR-010 Handle root commits and empty diffs honestly
    Given selected commit "ROOT" has no parent
    When I choose its changes against the empty tree
    Then added lines can be annotated against that explicit empty base
    When I choose two identical revisions
    Then the pane shows "No changes" and allows file-level guidance
    And it does not invent line changes

  Scenario: CR-011 Preserve review access when source cannot be displayed
    Given review "R1" exists for a file that is now missing or unreadable
    When I open review "R1"
    Then saved discussions and permitted original snippets remain available
    And the current source area gives a specific missing or unreadable state
    And the thread is not deleted or silently attached to another file

  Scenario: CR-091 Browse recent changes in a bounded file history
    Given the repository contains more commits than one history page
    When I open recent changes for the reviewed file
    Then the list shows a bounded newest-first page with commit IDs, subjects and timestamps
    And the file scope and any followed rename are explicit
    And selecting an entry shows its exact comparison without changing checkout
    And older entries can be paged without enumerating unrelated repository history

  Scenario: CR-092 Reopen the exact historical comparison
    Given review "R1" was opened against commit "C1" and parent "P1"
    And the repository has advanced since the review was created
    When I reopen its diff context
    Then the comparison still identifies "P1" and "C1"
    And unavailable old objects produce an explicit unavailable-diff state
    And saved comments are retained rather than moved to the newest commit

  Scenario: CR-111 Start a file review from the explorer without changes or an editor tab
    Given saved tracked file "src/stable.ts" has no staged or unstaged changes and is not open in an editor
    When I select it in the workspace explorer and choose "Review file"
    Then a separate review tab shows its full saved content and captured revision
    And file-level and line-range comments are available without selecting a commit or diff
    And no source editor buffer or agent turn is created

  Scenario: CR-112 Review a Git-less explorer file directly
    Given I selected saved text file "notes/design.txt" outside any Git repository
    When I choose "Review file" from the explorer actions
    Then the review opens in saved-file mode with full source and annotation controls
    And unavailable Git controls are absent or clearly disabled without blocking comments
    And no repository or sidecar file is created

  Scenario: CR-113 Keep ordinary explorer opening separate from review
    Given the Code Review add-on is installed
    When I use the explorer's ordinary open or "Open in editor" action for "src/main.ts"
    Then the existing editor path and behaviour are preserved
    And a review is opened only through the explicit review action or a saved review link

  Scenario: CR-114 Viewed is reading progress for a specific snapshot
    Given I marked a captured file as viewed and it has unresolved comments
    When its saved content changes and I refresh to a new snapshot
    Then that file is no longer shown as viewed for the new content digest
    And its comments remain unresolved and no review is sent automatically

  Scenario: CR-115 Explorer review is available without hover or right-click
    Given I selected a saved text file on a tablet
    When I open its visible file actions
    Then "Review file" is keyboard and touch accessible
    And choosing it opens the same saved-file review workflow as desktop
