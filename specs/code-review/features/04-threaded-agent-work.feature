@code-review @draft
Feature: Discuss guidance with an assigned agent inside its review thread

  Background:
    Given review "R1" belongs to the current operator
    And open thread "T1" contains saved guidance about "src/main.ts"
    And local agent session "Implementation" is a valid selected target

  Scenario: CR-033 Dispatch one saved thread explicitly
    When I choose "Send to agent" for "T1"
    Then a durable delivery intent references the thread and current guidance version
    And the host receives one request for the selected target
    And the pane shows queue acceptance separately from work completion
    And no other open review thread is implicitly dispatched

  Scenario: CR-034 Handle a busy target without silently interrupting it
    Given "Implementation" is busy with another turn
    When I send thread "T1" using the default queue mode
    Then the guidance is queued without forcing an interrupt or changing models
    And the thread shows the queue receipt and selected target

  Scenario: CR-035 Agent reads current guidance before acting
    Given an agent has received a reference to thread "T1"
    When it retrieves that thread through the review tool
    Then it receives the latest authorised public conversation and source snapshot identity
    And deleted text and unrelated reviews are not returned
    And the tool identifies whether the current file differs from the captured revision

  Scenario: CR-036 Persist an agent reply in the annotation thread
    When the assigned agent replies "I will preserve the public function signature"
    Then the reply is stored with trusted agent identity and a stable message ID
    And I can read it under the original comment without searching the general chat
    And closing or reloading the pane does not lose it

  Scenario: CR-037 Hold a multi-turn clarification conversation
    Given the agent asks "Should the fallback remain synchronous?" in thread "T1"
    When I post "Yes, keep that fallback" using "Send reply to agent"
    Then one user reply is persisted in "T1"
    And one delivery intent references that reply and current thread version
    When the agent answers "Understood"
    Then both replies appear in order beneath the same root comment
    And no reply creates a parallel unlinked discussion

  Scenario: CR-038 Post a reply without starting execution
    When I use "Post reply" to add contextual guidance
    Then the reply is durable in "T1"
    And no agent turn is queued until I explicitly send it

  Scenario: CR-039 Report blocked work without resolving the concern
    Given the assigned agent lacks approval or budget to perform a requested change
    When it reports the blocker in the thread
    Then the work state is blocked and the thread remains open
    And the pane offers a normal reply or explicit retry after the blocker is addressed
    And the add-on does not bypass the host approval or budget policy

  Scenario: CR-040 A failed queue submission preserves the discussion
    Given the host rejects a delivery before accepting it
    When I send "T1" to the agent
    Then the saved thread remains open and its delivery status shows failed
    And retry is available without reposting or duplicating the comment

  Scenario: CR-041 Reconcile an ambiguous delivery instead of replaying it
    Given the host accepted a delivery before the add-on lost its acknowledgement
    When the add-on resumes after a process failure
    Then the delivery is marked outcome unknown unless acceptance can be proven
    And no second turn or source modification is automatically scheduled
    And an operator can inspect correlation evidence before an explicit retry

  Scenario: CR-042 Changing instructions invalidates an old resolution attempt
    Given the agent is working from thread version 4
    When I edit my guidance so the current thread becomes version 5
    And the agent tries to resolve using version 4
    Then resolution is rejected as stale
    And the agent must read and address version 5 before resolving

  Scenario: CR-043 Explicit reassignment preserves the conversation
    Given thread "T1" is assigned to "Implementation"
    When I explicitly reassign it to local session "Reviewer"
    Then the same thread and conversation retain their identities
    And the assignment change is visible
    And late mutation attempts under the old assignment are rejected
    And reassignment alone does not claim to cancel the old session's ongoing work

  Scenario: CR-044 Distinguish session rotation from a different agent target
    Given "Implementation" rotates its runtime context but retains its authorised chat identity
    When it resumes the assigned review
    Then the durable conversation is retrievable under the same assignment
    When the target chat is deleted or can no longer be resolved
    Then dispatch and agent mutations fail closed until I select a valid target

  Scenario: CR-045 Show agent progress without storing private reasoning
    When the agent publishes a progress update or result in "T1"
    Then only its explicit public reply is stored
    And hidden reasoning, raw provider errors and unrelated tool output are absent
    And a provider or tool failure is not displayed as a completed resolution

  Scenario: CR-097 Double send reuses one durable dispatch intent
    Given I click "Send to agent" twice for the same pending send request
    When both requests arrive with the same intent ID and payload
    Then one durable intent and at most one first enqueue attempt exist
    And both responses refer to that intent's current state
    And a lost acknowledgement does not make a browser retry submit another turn

  Scenario: CR-098 Retry a definitively rejected dispatch with a correlated attempt
    Given the host rejected intent "D1" before acceptance
    When I explicitly retry the saved guidance
    Then a new numbered attempt belongs to "D1"
    And the thread content is not reposted as a new root comment
    And an unknown-outcome attempt cannot use this safe-retry path without reconciliation

  Scenario: CR-099 Review defaults apply only to future thread assignments
    Given "T1" is bound to resolved local chat "Implementation"
    When I change the review's default target to "Reviewer" and create thread "T2"
    Then "T2" suggests "Reviewer"
    And "T1" keeps its original target and history
    And neither change starts work by itself

  Scenario: CR-100 Reused aliases cannot redirect an existing thread silently
    Given "T1" is bound to a stable chat identity labelled "Implementation"
    And that chat is deleted and its alias is later reused by another chat
    When I try to send "T1" again
    Then the old target is unavailable until I explicitly reassign it
    And the new chat does not receive guidance merely by reusing the alias

  Scenario: CR-101 Deleting a thread retains a body-free work receipt
    Given "T1" has queued, in-progress or unknown-outcome delivery work
    When I confirm deletion of "T1"
    Then normal thread retrieval stops exposing its content
    And the operator can still inspect a body-free receipt for the outstanding work
    And no deleted guidance is resent during reconciliation
    And a late result updates only the receipt or is rejected without recreating "T1"

  Scenario: CR-102 Resolving a thread does not imply cancelling its active turn
    Given agent work for "T1" is queued or in progress
    When I resolve "T1" manually
    Then the UI keeps the work state distinct and does not claim cancellation
    And a queued worker rechecks the resolved state before performing source changes
    And late completion cannot silently reopen the thread or replace my resolution
