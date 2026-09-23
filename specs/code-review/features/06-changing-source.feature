@code-review @draft
Feature: Keep guidance correctly anchored as code changes

  Background:
    Given thread "T1" anchors to lines 12 through 14 in captured revision "S1"
    And the original selection and bounded context are persisted

  Scenario: CR-055 Refresh after unrelated lines are inserted
    Given later source revision "S2" inserts five lines before the unchanged selected block
    When I refresh the review
    Then a unique verified mapping projects "T1" onto the corresponding current range
    And the original "S1" anchor is still inspectable
    And the thread is not marked resolved by the refresh

  Scenario: CR-056 Changed anchored text is shown as outdated
    Given revision "S2" replaces the selected block with different code
    When I refresh the review
    Then "T1" retains its original snippet and is labelled outdated when no exact mapping can be verified
    And the pane offers original-context inspection and explicit re-anchoring
    And it does not attach the comment merely by reusing line numbers 12 through 14

  Scenario: CR-057 Repeated code creates ambiguity rather than a false match
    Given two current blocks match the old selected text and surrounding evidence is insufficient
    When the anchor is remapped
    Then "T1" is marked ambiguous
    And no block is chosen silently

  Scenario: CR-058 Explicitly re-anchor with visible provenance
    Given "T1" is outdated or ambiguous
    When I select a new current range and confirm re-anchoring
    Then a new projection records my chosen revision and range
    And the old anchor remains part of the thread history
    And the new projection does not alter the comment body
    And the open thread remains open

  Scenario: CR-059 Follow only a verified rename
    Given Git identifies one unambiguous rename from "src/main.ts" to "src/entry.ts"
    When I refresh the review
    Then the pane can show the current path "src/entry.ts" and the original path
    And the original revision identity remains unchanged
    When several rename candidates are equally plausible
    Then the pane requests explicit mapping instead of guessing

  Scenario: CR-060 Preserve a thread when a file is deleted and recreated
    Given the original reviewed file was deleted
    And a different file was later created at the same path
    When I reopen the old thread
    Then its original snapshot and deletion history remain visible
    And the new file is not assumed to inherit the old anchor

  Scenario: CR-061 A changing diff cannot mix revisions in one snapshot
    Given an agent modifies the working tree while a diff is being captured
    When the source identities no longer match the capture inputs
    Then the capture is retried within a bound or reported as changed during read
    And no comment can be posted against a falsely labelled mixed-revision diff

  Scenario: CR-062 Changing diff mode does not move earlier comments
    Given I posted a comment on a staged old-side line
    When I switch to unstaged changes or another commit pair
    Then the thread retains its staged snapshot and side
    And its location is shown as outside the current comparison unless a verified projection exists

  Scenario: CR-063 Do not overwrite a typed reply during source refresh
    Given I have an unsent reply draft open in "T1"
    When a new source snapshot and another agent reply arrive
    Then the source and discussion update without clearing my draft or changing its reply target
    And I can inspect what changed before posting

  Scenario: CR-064 Keep linked worktrees and repositories separate
    Given two registered worktrees contain the same relative file path
    When I review changes in one worktree
    Then comments and diff bases belong to that worktree identity
    And a switch to the other worktree cannot reuse anchors solely because paths match

  Scenario: CR-103 Moving a resolved concern requires explicit reopen
    Given "T1" was resolved against its original anchor in "S1"
    When I choose a different range in "S2" for re-anchoring
    Then I must confirm reopen-and-re-anchor or cancel
    And confirming creates an open concern at the new range
    And the prior resolution remains evidence only for its prior anchor
