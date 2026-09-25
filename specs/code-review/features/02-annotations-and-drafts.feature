@code-review @draft
Feature: Record precise source guidance as durable annotations

  Background:
    Given I am viewing saved revision "S1" of "src/main.ts" in review "R1"
    And no agent work has been queued for this review

  Scenario: CR-012 Create a line comment
    When I select line 12 and post "Keep validation before the network request"
    Then one open thread is stored with a unique ID and one user-authored message
    And its anchor records revision "S1", the file identity and line 12
    And a marker at line 12 opens that thread
    And posting alone queues no agent work

  Scenario: CR-013 Create a contiguous range comment
    When I select lines 12 through 18 and post "Extract the shared validation"
    Then the thread records both range endpoints and bounded source context
    And the selected range remains highlighted when I focus the thread
    And source code is not modified by the annotation

  Scenario: CR-014 Create file-level guidance without inventing a line
    When I post file-level guidance "Preserve the current public interface"
    Then the thread belongs to the file and revision without a line anchor
    And it is visible alongside line-level discussions

  Scenario: CR-015 Comment separately on old and new diff lines
    Given I am viewing a diff from "S0" to "S1" containing a deletion and an addition
    When I comment on the deleted old-side line
    And I separately comment on the added new-side line
    Then each thread retains its own diff side, revision pair and range
    And the deleted-line comment is not projected onto an unrelated new-side line

  Scenario: CR-016 Do not create an ambiguous cross-side range
    Given I am viewing a split diff
    When my selection crosses from the old side into the new side
    Then the pane requests a single-side range or file-level guidance
    And no misleading range is persisted

  Scenario: CR-017 Preserve a draft across normal navigation
    Given I typed an unpublished range comment
    When I switch to another source tab and return
    Then my draft text and original range are restored as a draft
    And no published message or agent dispatch exists for it

  Scenario: CR-018 Warn before discarding an unpersisted draft
    Given a draft could not be saved because its write failed
    When I try to close the review pane
    Then I can retry, keep editing or explicitly discard the draft
    And cancellation of the close retains the text
    And the UI does not claim the draft was saved

  Scenario: CR-019 Empty and oversized comments are not silently accepted
    When I attempt to post whitespace-only guidance
    Then no message is created and validation explains the problem
    When I attempt to post a comment beyond the documented limit
    Then the complete draft is retained with a size error
    And the server rejects the write rather than storing a truncated instruction

  Scenario: CR-020 Retry after an uncertain post does not duplicate a thread
    Given the server committed my new thread but the response was lost
    When the same posting request is retried with its original request ID
    Then the original thread and message are returned
    And exactly one comment exists

  Scenario: CR-021 Keep comments visible when filtering changes
    Given a file has several open and resolved threads
    When I filter for unresolved threads and select one
    Then its marker, source context and replies stay correlated
    And clearing the filter restores the other threads without changing their state

  Scenario: CR-093 Recover an acknowledged unpublished draft after restart
    Given the server acknowledged saving my unpublished draft and original anchor
    When the browser and Piclaw restart
    Then I can restore that draft from internal storage
    And it remains private to the operator and absent from published agent thread retrieval
    And no message or agent work is created until I publish or dispatch

  Scenario: CR-094 Do not promise recovery of unacknowledged offline keystrokes
    Given the connection failed before the newest draft edits were acknowledged
    When the pane reports its draft status
    Then it distinguishes the last saved draft from unsaved text in this browser
    And it warns before navigation could discard the unsaved text
    And reconnect merges only after checking the saved draft version
