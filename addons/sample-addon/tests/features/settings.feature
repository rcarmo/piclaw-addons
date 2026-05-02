Feature: Sample Addon settings pane
  As an add-on author
  I want the sample settings pane to work
  So developers can copy a tested add-on pattern

  Background:
    Given the "sample-addon" add-on is installed
    And I am on the main chat

  Scenario: Settings pane renders
    When I open Settings
    And I select the "Sample Addon" settings pane
    Then I should see the "Enabled" toggle
    And I should see the "Greeting" field
    And I should see the "API key" secret field

  Scenario: Greeting persists
    Given the "Sample Addon" settings pane is open
    When I set "Greeting" to "Hello from UX test"
    And I reload the settings pane
    Then the "Greeting" field should contain "Hello from UX test"

  Scenario: Secret save updates keychain indicator
    Given the "Sample Addon" settings pane is open
    When I save API key "sample-ux-secret"
    Then the keychain indicator should show the key is present
