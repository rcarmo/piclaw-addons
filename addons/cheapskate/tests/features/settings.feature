Feature: Cheapskate zero-cost catalogue settings
  As a Piclaw user
  I want Cheapskate settings to expose only exact-zero catalogue models
  So paid and unknown-cost models cannot be selected through cheapskate/auto

  Background:
    Given the "cheapskate" add-on is installed
    And I am on the main chat

  Scenario: Settings pane shows only zero-cost candidates
    Given a mixed zero-cost and paid Cheapskate catalogue is available
    When I open Settings
    And I select the "Cheapskate" settings pane
    Then I should see the free-model filter
    And I should see only exact-zero Cheapskate candidates
    And I should see catalogue-derived model capabilities

  Scenario: Free-model text and provider filters work
    Given a mixed zero-cost and paid Cheapskate catalogue is available
    And the "Cheapskate" settings pane is open
    When I filter Cheapskate models by text and provider
    Then only matching zero-cost Cheapskate candidates remain

  Scenario: Model enablement and priority persist
    Given a mixed zero-cost and paid Cheapskate catalogue is available
    And the "Cheapskate" settings pane is open
    When I enable and prioritise a zero-cost Cheapskate model
    And I reload the settings pane
    Then the Cheapskate model enablement and priority should persist
