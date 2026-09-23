@code-review @draft
Feature: Resolve and reopen concerns with explicit evidence

  Background:
    Given open thread "T1" belongs to review "R1"
    And its selected agent is authorised to reply and resolve

  Scenario: CR-046 Agent resolves after addressing the current concern
    Given the agent has read the latest guidance and saved-source revision
    When the agent resolves "T1" with a public explanation and change/check references
    Then the explanation and evidence are persisted with the resolution event
    And the thread becomes resolved with its author and timestamp visible
    And it remains available in resolved-thread history
    And resolution does not delete any discussion or source snapshot

  Scenario: CR-047 Explanation required even when no code change is appropriate
    When the agent proposes resolution without a public explanation
    Then resolution is rejected and the thread remains open
    When the agent explains why no source change is needed and resolves the current version
    Then that explicit reason is stored with the resolution
    And the pane does not fabricate a changed file or passing test

  Scenario: CR-048 Source edits alone never resolve comments
    Given the reviewed line changed during agent work
    When the file watcher refreshes the review pane
    Then the thread stays open until an explicit resolution action succeeds
    And disappearance of the original line is not treated as proof that guidance was followed

  Scenario: CR-049 User resolves a concern without an agent run
    When I explicitly resolve "T1" with my reason
    Then the thread records a user-authored resolution
    And no agent work is queued or reported as having fixed it

  Scenario: CR-050 Reopen and continue the same conversation
    Given "T1" is resolved
    When I choose "Reopen and reply" and post "This still fails for empty input"
    Then "T1" becomes open with a new user reply
    And earlier replies and the previous resolution remain in history
    And agent work is queued only if I also choose to send the reply

  Scenario: CR-051 Inspect the code revision associated with a resolution
    Given the agent resolved "T1" against source revision "S2"
    And the working copy has advanced to "S3"
    When I inspect the resolution evidence
    Then the pane distinguishes the cited "S2" from current "S3"
    And it does not relabel the old evidence as verification of the newer code

  Scenario: CR-052 Reject a resolve racing a new user reply
    Given the agent read thread version 8
    When a user reply commits as version 9 before the resolve request
    Then resolution against version 8 is rejected atomically
    And the new reply remains visible in the still-open thread

  Scenario: CR-053 Replying to resolved work is an explicit reopening choice
    Given "T1" is resolved
    When I start a new reply
    Then the pane asks me to reopen-and-post or cancel
    And it does not silently append new unresolved guidance beneath a resolved label

  Scenario: CR-054 Open and resolved counts reflect committed state
    Given the file has two open threads and one resolved thread
    When I resolve one open thread and reload the pane
    Then the counts show one open and two resolved
    And failed or cancelled resolution requests never change the counts
