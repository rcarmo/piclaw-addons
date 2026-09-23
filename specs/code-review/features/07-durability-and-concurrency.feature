@code-review @draft
Feature: Persist review conversations through failures and concurrent use

  Background:
    Given Code Review stores its state in its add-on-owned internal database
    And review "R1" has a thread with user and agent messages

  Scenario: CR-065 Browser reload restores the review
    When I reload the browser and reopen "R1"
    Then committed comments, authors, edits, thread state and source identities are restored
    And no browser-local flag is required to recover the conversation

  Scenario: CR-066 Process restart preserves history without replaying work
    Given "R1" contains an open thread, a resolved thread and an uncertain agent delivery
    When Piclaw restarts and the add-on loads
    Then both threads retain their messages and states
    And the uncertain delivery is shown for reconciliation
    And no model turn is blindly replayed on startup

  Scenario: CR-067 Reinstall retains durable reviews
    Given I disable or uninstall Code Review without requesting data deletion
    When I reinstall a compatible version and reopen "R1"
    Then the existing review and conversation are restored
    And no source repository or core messages database was deleted or reset

  Scenario: CR-068 Save failure does not discard a comment draft
    Given a comment persistence operation fails before commit
    When I attempt to post the comment
    Then the pane shows failure and retains the full draft
    And no saved indicator or agent dispatch is produced
    When I retry after storage recovers
    Then one committed comment appears

  Scenario: CR-069 Browser disconnect after commit is idempotent
    Given a reply committed before the browser lost its response
    When the browser reconnects and reconciles its pending request ID
    Then it obtains the original committed reply
    And no duplicate reply or dispatch is produced

  Scenario: CR-070 Different payloads cannot reuse an idempotency key
    Given request "K1" already created a comment with body "Keep this synchronous"
    When another request reuses "K1" with body "Make this asynchronous"
    Then the server reports a conflict
    And the original comment remains unchanged

  Scenario: CR-071 Concurrent replies retain a stable order
    Given a user and an agent reply concurrently to an open thread
    When both authorised replies commit
    Then both replies have stable IDs and server-assigned ordering
    And reconnecting readers see the same order without dropped messages

  Scenario: CR-072 Delete and reply races are atomic
    Given deletion and a new reply target the same thread version
    When those requests race
    Then one valid serial outcome is stored
    And deletion never leaves an invisible active discussion that still accepts replies
    And a losing writer receives a conflict or deleted-thread result

  Scenario: CR-073 Preserve source files while managing reviews
    When I add, edit, delete, reply to and resolve review comments
    Then the reviewed file bytes, Git index and commit graph do not change
    And only explicit normal-editor saves or authorised agent work can modify source

  Scenario: CR-074 Paginate long discussions without losing context
    Given "T1" contains more messages than one history page
    When I load earlier replies
    Then history pages remain scoped to "T1" with stable ordering
    And the root guidance, current resolution state and my reply draft remain available
    And an invalid or cross-thread cursor is rejected

  Scenario: CR-075 Dispose the pane without leaking background work
    Given I opened and closed the review pane repeatedly
    When the final pane is disposed
    Then its listeners, file watchers and active subscriptions are released
    And no tight polling, hidden tab loop or orphaned preview remains
    And closing the pane does not cancel independently queued agent work

  Scenario: CR-076 Reconnect after missed events from durable state
    Given the pane missed source or thread updates while disconnected
    When it reconnects with an outdated event cursor
    Then it reconciles against an authorised persisted snapshot
    And it does not invent unseen messages, replay dispatches or lose a draft
