@code-review @draft @data-contract
Feature: Own review records independently of source repositories and transient chats
  Record names refer to the logical design; observable invariants do not require one table per name.
  All filesystem, database, failure and restart fixtures are disposable.

  Background:
    Given the host supplies an authorised code-review data directory
    And the add-on stores review state in its own versioned SQLite database

  Scenario: CR-167 Keep durable review data in the scoped add-on store
    When I create a review, discussion, private draft and delivery intent
    Then their durable records belong under the host-provided code-review data directory
    And no source markers or sidecar review files are written into the reviewed repository
    And the add-on never opens the core message database directly to store review data
    And reinstalling the package does not replace or delete the review store

  Scenario: CR-168 Review identity survives path changes without creating accidental duplicates
    Given an authorised active review already exists for the selected worktree and saved path
    When I choose Review file again
    Then I can reopen that review or explicitly create a separate review
    And automatic tab navigation does not silently create another discussion container
    When the original review's file is renamed
    Then its durable review ID remains independent of the current path label

  Scenario: CR-169 Persist immutable source captures and comparison membership
    When I capture a source file or multi-file comparison
    Then a snapshot records its source mode, capture time and exact revision or content identities
    And each snapshot-file record retains old and new paths, change kind and referenced source blobs
    And an updated working tree creates a new snapshot rather than overwriting the old bytes
    And line or file anchors can still recover their original permitted source context

  Scenario: CR-170 Keep content identity exact while bounding stored source
    Given two captures contain identical source bytes and another differs only in newline encoding
    When their source blobs are stored under the same authorised workspace scope
    Then identical bytes may reuse a content identity while the different bytes have a different digest
    And decoding or compression does not rewrite the original content identity
    And configured size and access limits apply before storing or returning source

  Scenario: CR-171 Preserve immutable anchors alongside later projections
    Given a thread is anchored to the old side of a captured file range
    When new captures or an explicit remap produce current projections
    Then its original snapshot-file reference, side, logical range and bounded context remain unchanged
    And each projection identifies its new snapshot, mapping result and method or actor
    And an ambiguous or missing projection never overwrites the original anchor

  Scenario: CR-172 Version discussion messages without changing their identities
    Given a thread contains ordered human and agent replies
    When an authorised author edits their own message at its expected version
    Then the message ID, trusted author and ordinal remain stable
    And its current revision changes with an edited indication and a concurrency version
    And another writer using the older expected version cannot silently overwrite it

  Scenario: CR-173 Deleted bodies cannot survive in normal retrieval shortcuts
    Given a message body was referenced by revisions, dispatch items and cached mutation results
    When an authorised deletion commits
    Then its bodies are removed from add-on revisions and ordinary API, tool and idempotency-result retrieval
    And body-free IDs and tombstones retain reply ordering and delivery correlation
    And a later retry or batch retrieval cannot reconstruct the deleted text from a duplicated payload
    And the UI does not claim to recall copies already delivered to an agent or erase existing backups

  Scenario: CR-174 Keep private drafts separate from published guidance
    Given an acknowledged unpublished draft is associated with an owner and prospective range or reply target
    When a selected agent lists or reads that review
    Then only authorised published guidance is returned and the private draft is absent
    When the operator explicitly posts or sends that draft
    Then the publication uses its expected version and creates the corresponding message once
    And a draft write by itself creates no delivery intent

  Scenario: CR-175 Retain a fixed batch selection with independent item results
    When I submit selected threads as one review with an optional overall instruction
    Then one dispatch records the resolved target identity, queue mode and immutable payload hash
    And ordered dispatch items reference the selected thread versions, assignments and source snapshots
    And the overall instruction is versioned with that dispatch rather than silently edited after queueing
    And each item records its own work outcome without merging the original conversations

  Scenario: CR-176 Claim delivery once across concurrent workers and restart
    Given a prepared dispatch attempt is visible to two workers
    When both try to claim the same first enqueue attempt
    Then only one durable claim may move it to attempting and call the host
    When the process dies after host acceptance but before the receipt write
    Then recovery marks the attempt unknown rather than assuming rejection or replaying it
    And explicit reconciliation or a safe numbered retry retains the same dispatch correlation

  Scenario: CR-177 Preserve request idempotency without replaying deleted content
    Given an operator mutation succeeded with request ID K1 and a recorded payload hash
    When the same authorised request is repeated
    Then it returns the existing record identities and their permitted current state without another mutation
    When a changed action or payload reuses K1
    Then it is rejected as a conflict
    And another owner cannot read or reuse K1 as authority over the first owner's records

  Scenario: CR-178 Bind local agents across context rotation but not alias reuse
    Given a thread is bound to a durable local chat identity and assignment epoch
    When that agent rotates its runtime model context
    Then the authorised binding remains valid without depending on the discarded transient session ID
    When the target chat is deleted and another chat takes its alias
    Then the old assignment is unavailable until explicitly reassigned
    And a late mutation from the previous assignment epoch cannot change the new assignment's discussion

  Scenario: CR-179 Store resolution evidence against the version actually addressed
    Given the assigned agent resolves the current thread against source snapshot S2
    When that resolution event is committed
    Then its actor, time, thread version, source snapshot and bounded public evidence are recorded together
    And later edits or refreshes do not relabel that evidence as applying to a newer version
    And a later reopen creates an event while preserving the earlier explanation and source reference

  Scenario: CR-180 Keep thread delivery and work states independent
    Given the host accepted a two-item review but only one concern was resolved
    When I inspect persisted state or reopen the pane
    Then accepted delivery, per-item work outcomes and open or resolved thread states remain separately represented
    And one completed item cannot mark every thread resolved or hide another item's blocker
    And resolving a thread manually does not falsely cancel or complete its outstanding delivery attempt

  Scenario: CR-181 Failed schema migration preserves the existing review database
    Given retained review data uses a supported older schema
    When a migration fails before committing its transaction
    Then existing review data remains intact and the add-on reports the migration failure
    And it does not delete, recreate or partially advance the store to appear healthy
    And opening a newer unsupported schema fails explicitly without destructive downgrade

  Scenario: CR-182 Restore review records without binding them to an unrelated workspace
    Given a consistent backup of the add-on store and retained source snapshots exists
    When it is restored into an authorised compatible test instance
    Then review identities, discussions, drafts, resolutions and delivery receipts can be recovered
    And current file access and agent assignments are revalidated against the restored host
    And matching path strings alone cannot bind old anchors to a different workspace or worktree
    And restored unknown or active attempts are reconciled without automatically repeating source work

  Scenario: CR-183 Reference validation rejects cross-review and dangling records atomically
    Given a valid thread belongs to review R1 and snapshot-file F2 belongs to another review
    When a mutation attempts to attach that thread, draft or dispatch item to F2
    Then the service rejects the invalid relationship within the transaction
    And no partial message, item, receipt or event is left behind
    And identical source digests never substitute for checking review ownership

  Scenario: CR-184 Store only review state that serves the agreed workflow
    When I browse files, change layout, select a range or include a thread for a future send
    Then no Viewed or read-progress record is created
    And selection, scroll and layout preferences do not imply source approval or queued work
    And only an explicit published mutation or dispatch writes the corresponding authoritative review records
