@code-review @draft @host-contract
Feature: Integrate review actions and panes through supported Piclaw contracts
  Missing host hooks require generic host work before these scenarios can pass.
  The add-on must not simulate missing authority by patching DOM or importing private runtime modules.

  Background:
    Given Code Review is installed in a disposable Piclaw workspace
    And all review routes and agent tools must use host-derived local authority

  Scenario: CR-155 Register an explicit explorer action without taking over file opening
    Given the host supports registered add-on workspace actions
    When the add-on registers Review file for supported saved text files
    Then the selected-file menu and touch-accessible file actions expose that command
    And it receives the host-validated selected file context
    And ordinary double-click and Open in editor behaviour are unchanged
    And no injected explorer DOM listener is required

  Scenario: CR-156 Route review IDs through the pane registry
    Given the add-on registered its review-only virtual-path handler
    When I open a durable review link through the host pane launcher
    Then the pane registry mounts the review with a review-specific tab identity and readable label
    And that identity does not collide with an ordinary editor tab for the same source path
    And the review handler does not claim all text filenames or depend on a private editor instance

  Scenario: CR-157 Fail closed when a required host contract is missing
    Given the host lacks supported explorer launch, trusted context or authorised target binding
    When I attempt the affected review operation
    Then it shows a specific unavailable-capability result
    And it does not patch host internals, invent an owner, use a slash-command bridge or spoof a peer principal
    And no source, review data or agent execution is created through an alternate unauthorised path

  Scenario: CR-158 Handle an unavailable add-on behind a saved review tab
    Given Code Review is disabled or missing but its virtual tab path was restored
    When the host resolves that tab or a saved review link
    Then it shows the add-on unavailable state without opening a synthetic filesystem path in the source editor
    And Save and Reveal in explorer do not treat the virtual review ID as a real source file
    And re-enabling the add-on can reopen its retained authorised review records

  Scenario: CR-159 Pop out and reattach without copying review ownership into the URL
    Given I have an acknowledged comment draft, active file and source selection in a review
    When I pop out that review using Piclaw's tab controls and then reattach it
    Then the same review and discussion IDs remain authoritative in internal storage
    And authorised active-file and scroll or selection state can be restored
    And no comment body, secret or ownership grant is encoded in the popout URL
    And a fresh host resolves the review's access instead of trusting client transfer state

  Scenario: CR-160 Distinguish comment draft dirtiness from source editing
    Given comment persistence failed and I have unacknowledged composer text
    When I press the host's close-tab action
    Then the pane reports unsaved comment work through the supported close or dirty contract
    And cancelling close preserves the composer
    When I save that draft successfully
    Then the pending-draft indicator clears without writing any reviewed source file

  Scenario: CR-161 Switching reviews does not leave hidden work scanning source
    Given several review tabs contain acknowledged drafts and subscriptions
    When I switch tabs, hide the pane or close a review
    Then the inactive or disposed instance releases or suspends unnecessary listeners, parsing and fetch work
    And acknowledged data remains recoverable from the add-on store
    And closing a tab does not cancel separately queued agent work

  Scenario: CR-162 Treat the opening chat as a suggestion rather than identity proof
    Given the browser reports the chat from which the review was opened
    When the backend binds the default review target
    Then the host resolves and authorises that local target under the current operator
    And the opening chat is visibly suggested with a picker for another authorised local agent before sending
    And opening the picker or choosing a target does not queue a review
    And a forged URL parameter or browser-supplied chat ID cannot select an unrelated target
    And missing trusted context reports unavailable instead of silently choosing web:default

  Scenario: CR-163 Use authenticated add-on actions and the same service as agent tools
    When browser actions or agent tools read and mutate the same review
    Then both paths apply the same ownership, expected-version and author checks
    And browser actions use the authenticated direct add-on API rather than slash-command relay
    And the review service does not expose operator data through pre-auth external transport routes
    And the host establishes the actual author identity instead of accepting model text as an author claim

  Scenario: CR-164 Deliver one local instruction through the normal queue
    Given a valid single-thread or selected-batch intent is ready for an authorised local target
    When its first delivery attempt is claimed
    Then the add-on invokes the supported host enqueue contract with queue mode
    And the instruction identifies the review and dispatch so the agent can retrieve bounded current guidance
    And the host's ordinary budget, approval and tool restrictions remain in force
    And a queue receipt is stored without pretending it guarantees agent completion

  Scenario: CR-165 Recover updates from records rather than trusting transient notifications
    Given a review client missed conversation or delivery notifications while disconnected
    When it resumes from its last durable event cursor
    Then it reads authorised changes from internal records or a bounded replacement snapshot
    And duplicate or missing notifications cannot duplicate messages, dispatches or resolutions
    And lack of a supported subscription leaves an explicit Refresh path rather than hidden recurring polling

  Scenario: CR-166 Keep source review independent of cloud review services
    When I open the review pane, its preferences or a local thread link
    Then no GitHub or Gitea account, PR API, telemetry endpoint or remote reviewer is required
    And preferences stay in Settings while source discussion stays in the review pane
    And no Approve PR, Merge branch or Apply suggested patch action is added in this version
