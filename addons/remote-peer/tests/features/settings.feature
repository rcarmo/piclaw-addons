Feature: Iroh Remote Peer settings
  As an operator
  I want client-ID pairing and discovery controls in Settings
  So I can enable only the network services I intend to use

  Background:
    Given the "remote-peer" add-on is installed
    And I am on the main chat
    And Remote Peer is reset to disabled direct-only settings

  Scenario: Fresh client ID and network discovery default to off
    Given the "Remote Peer" settings pane is open
    Then I should see a checksummed Remote Peer client ID
    And the Remote Peer client-ID pairing field should be available
    And Remote Peer mDNS should be off
    And Remote Peer internet address lookup should be off

  Scenario: Enabling Iroh does not enable mDNS
    Given the "Remote Peer" settings pane is open
    When I enable Remote Peer in Settings
    Then Remote Peer should report "Listening"
    And Remote Peer mDNS should be off
    When I disable Remote Peer in Settings
    Then Remote Peer should report "Stopped"
