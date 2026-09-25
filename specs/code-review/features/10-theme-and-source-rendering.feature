@code-review @draft @rendering
Feature: Render dense source and readable diffs using the active Piclaw theme
  Numeric density checks use 100 percent browser zoom and the standard host font setting.
  Native panes inherit host tokens directly; standalone mock bridging is not a required production mechanism.

  Background:
    Given an authenticated operator opened a saved-source review in a disposable Piclaw workspace
    And source code is read-only while comment and reply composers remain editable

  Scenario: CR-142 Keep source rows compact in every layout
    Given source, unified diff and split diff fixtures contain unwrapped nonblank and blank lines
    When I render them at supported desktop, tablet and phone pane widths
    Then code text is 12 CSS pixels on an 18 CSS pixel line box with zero vertical row padding
    And gutter buttons do not increase row height or add vertical gaps
    And token spans introduce no padding, background or font-size overrides
    And comment and toolbar control dimensions remain independent of source row dimensions

  Scenario: CR-143 Honour the active host theme over the operating-system preference
    Given the operating system prefers light mode while Piclaw uses a dark theme
    When I open the review pane
    Then its surfaces, borders, text, accents, code colours and font roles use Piclaw's computed tokens
    When Piclaw switches to a light theme while the operating system prefers dark
    Then the review follows Piclaw without installing a separate review palette

  Scenario: CR-144 Apply theme and custom-tint changes without rebuilding the review
    Given a source selection, scroll position and unposted comment are present
    When the host changes theme tokens or applies a custom CSS tint
    Then the review recolours using the updated host values without remounting source
    And the selected range, original anchor, scroll position and comment text are preserved
    And theme synchronisation adds no recurring timer or unrelated host-state mutation

  Scenario: CR-145 Tint the current code background green and red
    Given the active theme provides a code background and code foreground
    When additions and deletions are displayed
    Then added rows use a 14 percent sRGB green wash from colour "#2da44e" over the current code background
    And deleted rows use a 12 percent sRGB red wash from colour "#cf222e" over the current code background
    And ordinary code text and syntax roles retain their active-theme foregrounds
    And unchanged rows retain the untinted code background
    And old and new line numbers and plus or minus markers remain visible without relying on colour alone

  Scenario: CR-146 Preserve diff meaning when host semantic colours are monochrome
    Given Piclaw's success and danger tokens both resolve to the same monochrome colour
    When I review additions and deletions
    Then addition and deletion washes remain distinct green and red mixtures over that theme's code surface
    And the rest of the pane still uses the active monochrome theme
    And range selection adds a focus or accent indicator without erasing either diff wash

  Scenario: CR-147 Render syntax through Piclaw token roles
    Given a supported source contains keywords, definitions, functions, types, strings, numbers, booleans and comments
    When I view its saved source
    Then the displayed tokens use the corresponding host syntax-role colours
    And function names are not collapsed into ordinary variable colouring
    And numbers and booleans retain their separate role mappings
    And template-string tokens use the host string role even when the parser labels them as string2

  Scenario: CR-148 Tokenise old and new documents before slicing diff lines
    Given an old snapshot opens a multiline comment which the new snapshot closes on another line
    When I inspect a hunk beginning inside that comment in unified and split layouts
    Then each side is highlighted from its own complete bounded source snapshot
    And multiline comment, string and template-string state carries across hidden context
    And patch prefixes and the opposite side's tokens never become parser input for this side
    And the same saved line retains the same tokens across layout switches

  Scenario: CR-149 Syntax rendering preserves exact text and anchor coordinates
    Given a saved fixture contains tabs, leading spaces, blank lines, trailing newline and HTML-like text
    When syntax spans are produced and I copy a selected code range
    Then displayed and copied code preserves the source characters without line numbers or span markup
    And blank lines do not acquire synthetic content when copied
    And source digests and side-specific logical line coordinates remain unchanged
    And source text cannot create executable markup or event handlers

  Scenario: CR-150 Fall back without making unsupported files unreviewable
    Given a saved text file has an unknown extension or its syntax parser fails
    When I open it for review
    Then escaped plain text is shown with an honest plain-text or unavailable-highlighting indicator
    And line and file comments remain available on its original snapshot
    And no unrelated grammar is guessed from the contents
    And no dynamic import failure turns the code into an editable fallback

  Scenario: CR-151 Separate the highlighting limit from the review-file limit
    Given a supported source snapshot exceeds the 96 KiB highlighting budget but fits the configured review-file limit
    When I open its source or diff
    Then parsing is skipped and bounded escaped plain text remains reviewable
    And the pane identifies the reduced highlighting mode without truncating saved guidance
    And the parser limit cannot be bypassed by switching to split view or expanding a hunk

  Scenario: CR-152 Reject stale highlighting after changing snapshots
    Given tokenisation for snapshot S1 is still pending
    And I have switched the pane to snapshot S2 of the same path
    When S1's token result arrives
    Then it cannot paint S2 or move S2's line anchors
    And cached token output is keyed by the source identity, language and grammar version
    And cache growth and pending parsing work remain bounded and cancel or detach on disposal

  Scenario: CR-153 Markdown and plain text remain source reviews
    Given I selected a saved Markdown file or a Git-less plain-text file in the explorer
    When I choose Review file
    Then Markdown syntax may be coloured but the saved characters are not replaced by a rendered article
    And unsupported plain text is escaped without invented syntax roles
    And both modes retain file and range annotation support without requiring a code editor

  Scenario: CR-154 Browser zoom and forced colours preserve controls and diff labels
    Given I use browser zoom, keyboard focus or a forced-colour accessibility mode
    When I inspect code, line controls and inline discussions
    Then source text and controls remain reachable without clipping the pane's actions
    And line numbers, diff signs and labelled thread states still communicate their meaning
    And no script counteracts user zoom to enforce a physical-pixel row size
