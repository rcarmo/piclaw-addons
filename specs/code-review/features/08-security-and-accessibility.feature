@code-review @draft
Feature: Keep reviews local authorised accessible and bounded

  Background:
    Given Code Review is running in a disposable supported single-operator workspace
    And its pane uses authenticated local add-on APIs

  Scenario: CR-077 Reject unauthenticated and cross-origin mutation
    When an unauthenticated or cross-origin caller attempts to create or edit a comment
    Then host authentication and request-origin protections reject it
    And no review data or execution request is created

  Scenario: CR-078 Author and target identities come from trusted context
    When a client supplies another author identity or an unauthorised target in a request body
    Then the server rejects the forged identity or target
    And no user comment is recorded as an agent message
    And no unrelated chat is queued

  Scenario: CR-079 Guessing IDs cannot cross review boundaries
    Given the agent is authorised only for review "R1"
    When it guesses a thread or snapshot ID belonging to another review
    Then read and mutation tools return no protected content
    And using that ID as a parent or resolution reference is rejected

  Scenario: CR-080 Deny unsupported family or remote exposure
    Given the host cannot establish a supported local review owner
    When Code Review is opened or invoked from that context
    Then it reports unavailable rather than falling back to the default chat identity
    And it exposes no comments, source snapshots or execution authority to that caller

  Scenario: CR-081 Reject workspace escapes and hostile Git arguments
    When a request supplies a traversal path, a symlink escape or a crafted revision argument
    Then source and diff reads are rejected before filesystem or Git side effects
    And no shell interpolation, external diff driver or text conversion command executes

  Scenario: CR-082 Treat document and comment contents as untrusted text
    Given filenames, source lines or comment Markdown contain script and unsafe-link payloads
    When the pane renders source, diffs, threads and resolution evidence
    Then scripts and unsafe URLs do not execute
    And code text does not become a host instruction or grant additional tools

  Scenario: CR-083 Bound source and comment reads honestly
    Given a source snapshot, diff or comment exceeds the documented limits
    When it is read or submitted
    Then a bounded limit state identifies the unsupported content
    And stored guidance is not silently truncated or exposed through unrestricted downloads
    And existing threads remain accessible where authorised

  Scenario: CR-084 Review content is not sent to external services by opening a pane
    When I open a file, inspect a diff or browse review history
    Then no third-party review service, analytics endpoint or remote agent receives the content
    And only an explicit dispatch may send bounded context through the configured local agent session

  Scenario: CR-085 Keyboard users can annotate and converse
    Given I use the keyboard without a pointer
    When I select a source range, open its comment editor, post, reply, edit and cancel
    Then each action has an accessible name and visible focus
    And focus returns to its originating control when a transient editor closes
    And save/error/status changes are announced without moving focus unexpectedly

  Scenario: CR-086 Tablet users can target a precise range
    Given I use the pane on a tablet with touch input
    When I choose a start and end line and add guidance
    Then the range is visible before posting
    And source scrolling does not accidentally post or delete a comment
    And the reply controls remain reachable with the on-screen keyboard open

  Scenario: CR-087 Classic retains usable narrow layouts
    Given the pane is opened in Classic with a light or dark theme
    When its viewport is resized through desktop, tablet, 520px and 390px widths
    Then the source and thread areas can be switched or resized without hidden actions
    And comments, controls and status text do not clip outside the pane
    And text fields and buttons follow Classic's control contract
    And long lines can scroll without pushing the conversation controls off-screen

  Scenario: CR-088 Preserve draft safety on Escape and tab close
    Given a comment or reply editor contains unsaved text
    When I press Escape or close its containing pane
    Then no saved comment is deleted
    And unpersisted text requires an explicit discard choice or remains recoverable
    And a cancelled close returns focus to the draft

  Scenario: CR-089 Keep idle work bounded
    Given several code review tabs are open and only one is visible
    When there are no source or conversation changes
    Then inactive tabs do not perform recurring full-file or full-history scans
    And subscriptions and refresh work remain bounded by visible demand
    And reopening a tab obtains current authorised state before allowing mutations

  Scenario: CR-090 Export and clipboard actions do not leak by implication
    When I copy a thread link or source reference
    Then the copied value is an authenticated local reference rather than a public share grant
    And no source or discussion is uploaded or published implicitly

  Scenario: CR-116 Every control has native helper text
    When I open source, diff, comment and submission views
    Then every actionable control has a descriptive standard HTML title attribute
    And dynamically rendered controls retain that helper text after state changes
    And no custom tooltip overlay or touch interception replaces browser behaviour

  Scenario: CR-117 Thread checkboxes have only dispatch-selection meaning
    When I inspect the Include in send checkboxes
    Then their visible labels and titles explain that checking only selects a thread
    And there is no Viewed or reading-progress checkbox
    And selected threads wait for a later explicit send
    And selection never approves code, resolves a concern or starts agent work

  Scenario: CR-118 Disabled action helper text explains the current blocker
    Given a send is unavailable because selection is empty, a thread is queued or resolved, or targets differ
    When the affected controls are rendered
    Then their title attributes explain the applicable blocker without suggesting work was sent
    And the disabled controls remain inert
    And essential status and accessible names remain available without relying on native tooltip display

  Scenario: CR-119 Highlight complete snapshots without mixing diff sides
    Given old and new source snapshots contain multiline comments or strings with different boundaries
    When I view saved source and switch between unified and split diffs
    Then tokens reflect each complete snapshot independently before line slicing
    And source text, line numbers and comment anchor sides remain unchanged

  Scenario: CR-120 Syntax colours follow Piclaw without erasing diff tints
    Given a highlighted diff has selected lines and an unposted comment draft
    When I change the active Piclaw theme or its syntax colours
    Then token colours update through the host syntax roles without remounting the review
    And addition and deletion backgrounds keep their green and red theme washes
    And compact line heights, source selection and the draft are preserved

  Scenario: CR-121 Highlighting fails safely to escaped source
    Given source contains HTML-like text or has an unsupported language, parser failure or excessive highlighting size
    When the source renderer processes it
    Then source text cannot create active markup or execute code
    And unsupported or failed highlighting returns escaped plain text without disabling comments
    And copying or anchoring source does not include token markup
