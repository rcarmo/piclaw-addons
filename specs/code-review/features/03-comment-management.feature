@code-review @draft
Feature: Add edit and delete comments without losing conversation integrity

  Background:
    Given open thread "T1" contains a user root comment and an agent reply
    And the current operator owns review "R1" containing thread "T1"

  Scenario: CR-022 Edit my published comment
    When I change my root comment and save it at its expected version
    Then the updated body appears with an edited indicator and new version
    And the comment ID, original anchor and existing agent reply remain unchanged
    And editing does not enqueue work automatically

  Scenario: CR-023 Cancel an edit
    Given I am changing my published comment
    When I cancel the edit
    Then the last saved body remains authoritative
    And no new comment version is written

  Scenario: CR-024 Refuse a conflicting stale edit
    Given another tab has already updated the same comment
    When I save my older editor version
    Then the server rejects the stale write
    And the pane preserves my draft and offers the latest saved body for comparison
    And neither version silently overwrites the other

  Scenario: CR-025 Delete my comment while preserving replies
    When I request deletion of my comment
    And I confirm the deletion
    Then the ordinary conversation shows a deletion tombstone with no comment body
    And agent replies retain their IDs, authorship and chronological positions
    And agent thread retrieval no longer returns the deleted body

  Scenario: CR-026 Cancel a destructive action
    When I request deletion of a comment or a whole thread
    And I cancel the confirmation
    Then no comment, thread, reply or resolution state changes

  Scenario: CR-027 Delete an entire discussion explicitly
    When I confirm deletion of thread "T1"
    Then the thread is removed from ordinary lists and source markers
    And its messages are unavailable through normal UI and agent retrieval
    And the internal identity tombstone prevents retry requests from recreating it

  Scenario: CR-028 Editing or deleting dispatched guidance cannot recall it
    Given an earlier version of my comment was already delivered to an agent
    When I edit or delete that comment
    Then the pane explains that previously delivered content cannot be recalled
    And the next authorised thread read exposes its latest version or deletion
    And deletion does not claim to undo source changes or cancel an active agent turn

  Scenario: CR-029 Preserve authorship boundaries
    When I try to rewrite an agent reply as if the agent wrote different text
    Then the request is denied and the agent reply is unchanged
    When the agent tries to edit or delete the user's comment
    Then the tool request is denied and the user's comment is unchanged

  Scenario: CR-030 Agent correction retains its reply identity
    Given the assigned agent has posted its own reply
    When that agent corrects the reply using its current version
    Then the same reply ID has an edited indicator and the corrected public body
    And neither the user message nor another agent's reply is changed

  Scenario: CR-031 Deletion wins over a late retry
    Given a message was deleted after its first write
    When a stale client retries the original create or edit request
    Then no deleted content reappears
    And the client receives the existing deletion or a conflict result

  Scenario: CR-032 A late reply cannot resurrect a deleted thread
    Given thread "T1" was deleted while an agent was working on it
    When the agent attempts to append its result to "T1"
    Then the reply tool reports that the thread was deleted
    And no new thread or source marker is created implicitly

  Scenario: CR-095 Edit and delete my own threaded reply
    Given my reply follows an agent clarification inside "T1"
    When I edit that reply at its current version
    Then its reply ID and parent thread remain stable and it gains an edited indicator
    When I confirm deletion of that reply
    Then its body is removed from ordinary views and agent retrieval
    And other replies and their ordering remain unchanged

  Scenario: CR-096 Agent may delete its own reply without rewriting user guidance
    Given the assigned agent owns reply "A1"
    When it deletes "A1" using the current message version
    Then a tombstone replaces only that reply body
    And the user's messages and thread state are unchanged
    And resolution records referencing that reply indicate the evidence was removed
