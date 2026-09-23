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

  Scenario: CR-104 Send selected comments across files as one review
    Given open threads "T1" and "T2" annotate different saved files in "R1" for "Implementation"
    And "R1" also contains unselected thread "T3" and an unpublished comment draft
    When I select "T1" and "T2" and preview "Send to agent"
    Then the preview shows exactly those threads with their guidance versions, source snapshots and target
    And selecting and previewing alone creates no delivery intent or agent turn
    When I confirm sending the selection
    Then one durable batch intent records both items and one initial enqueue attempt for "Implementation"
    And neither "T3" nor the unpublished draft is included or dispatched
    And both selected threads retain their own anchors and conversation IDs

  Scenario: CR-105 Keep batch replies and outcomes attached to individual threads
    Given batch "B1" contains "T1" and "T2" and the agent re-read both current threads
    When the agent replies with evidence and resolves "T1" but reports a blocker on "T2"
    Then each response appears in its original thread and source context
    And "T1" is resolved while "T2" stays open with a blocked work state
    And the batch shows partial results rather than claiming all guidance was resolved
    And no completed item is automatically replayed because another item is blocked

  Scenario: CR-106 Reject a changed batch selection before any dispatch
    Given I previewed versions of "T1" and "T2" in one batch
    And "T2" was edited or deleted before I confirmed the preview
    When I submit that batch with the previewed item versions
    Then validation rejects the whole submission before recording an accepted intent or enqueueing work
    And "T1" is not silently sent as a smaller batch
    And the pane preserves my selection and requests a refreshed preview

  Scenario: CR-107 Require one valid target for a batch
    Given "T1" belongs to "R1" and is assigned to "Implementation"
    And "T2" belongs to "R1" and is assigned to "Reviewer"
    When I attempt to submit them together to "Implementation"
    Then no batch is dispatched until I explicitly reassign eligible threads or send separate batches
    And no thread changes target merely because it was selected
    And the add-on does not silently fan out turns to multiple agents

  Scenario: CR-108 Reject an out-of-scope batch item without partially sending valid items
    Given I can dispatch "T1" in "R1" but cannot access thread "Other"
    When a batch submission contains both IDs
    Then the entire submission is rejected before any enqueue attempt
    And no protected content or existence detail about "Other" is returned
    And the valid "T1" item is not sent separately

  Scenario: CR-109 Repeated batch sends reuse the intent and its frozen selection
    Given the host accepted batch intent "B1" for "T1" and "T2" but its acknowledgement was lost
    When the same intent ID and payload are submitted again
    Then the existing delivery state is returned without another enqueue attempt
    And the outcome stays unknown unless acceptance can be reconciled
    When a request reuses "B1" but substitutes "T3" for "T2"
    Then a payload conflict is returned and no new selection is dispatched

  Scenario: CR-110 Recheck changed items when a queued batch begins
    Given batch "B1" contains "T1" and "T2" and is queued for "Implementation"
    And "T2" is deleted, resolved or reassigned before the agent starts
    When the agent retrieves the batch to begin work
    Then current authority and state are checked separately for each item
    And no stale or unauthorised action is performed for "T2"
    And its body-free outcome is superseded or unavailable while eligible "T1" can proceed
    And neither thread is recreated or silently reopened
