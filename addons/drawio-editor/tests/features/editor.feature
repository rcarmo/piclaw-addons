Feature: Draw.io 31.4.2 workspace editor

  Background:
    Given the "drawio-editor" add-on is installed
    And I am on the main chat

  Scenario: Real editor exposes only the supported file and export menus
    Given a Draw.io workspace file "drawio-e2e-menu.drawio" exists
    When I open the Draw.io editor for "drawio-e2e-menu.drawio"
    Then the embedded Draw.io version is "31.4.2"
    And the Draw.io menus contain only Save, Export As, PNG, JPEG, and SVG

  Scenario: XML edits autosave and survive editor reload
    Given a Draw.io workspace file "drawio-e2e-autosave.drawio" exists
    When I open the Draw.io editor for "drawio-e2e-autosave.drawio"
    And I edit the rectangle label to "AUTOSAVE-31.4.2"
    Then "drawio-e2e-autosave.drawio" contains "AUTOSAVE-31.4.2"
    When I reload the Draw.io editor
    Then the diagram contains a cell labelled "AUTOSAVE-31.4.2"

  Scenario: Manual save acknowledges and persists XML
    Given a Draw.io workspace file "drawio-e2e-manual.drawio" exists
    When I open the Draw.io editor for "drawio-e2e-manual.drawio"
    And I edit the rectangle label to "MANUAL-SAVE-31.4.2"
    And I choose Save from the Draw.io File menu
    Then the Draw.io editor reports "Saved"
    And "drawio-e2e-manual.drawio" contains "MANUAL-SAVE-31.4.2"

  Scenario: Reduced export menu writes PNG JPEG and SVG siblings
    Given a Draw.io workspace file "drawio-e2e-export.drawio" exists
    When I open the Draw.io editor for "drawio-e2e-export.drawio"
    And I edit the rectangle label to "EXPORT-31.4.2"
    And I export the diagram as "PNG"
    Then the workspace file "drawio-e2e-export.png" has a PNG signature
    When I export the diagram as "JPEG"
    Then the workspace file "drawio-e2e-export.jpg" has a JPEG signature
    When I export the diagram as "SVG"
    Then the workspace file "drawio-e2e-export.svg" contains "<svg"

  Scenario: Embedded PNG and SVG diagrams round-trip after reload
    Given a Draw.io workspace file "drawio-e2e-embedded.drawio" exists
    When I open the Draw.io editor for "drawio-e2e-embedded.drawio"
    And I edit the rectangle label to "EMBEDDED-31.4.2"
    And I export the diagram as "PNG"
    And I export the diagram as "SVG"
    Then reopening "drawio-e2e-embedded.png" shows "EMBEDDED-31.4.2"
    And reopening "drawio-e2e-embedded.svg" shows "EMBEDDED-31.4.2"

  Scenario: Attachment preview remains read-only
    Given a Draw.io media attachment named "preview.drawio" exists
    When I open its Draw.io attachment preview
    Then the Draw.io attachment editor is read-only
    And the read-only overlay blocks editing
