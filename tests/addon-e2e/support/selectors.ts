export const sel = {
  settingsDialog: '[data-testid="settings-dialog"], .settings-dialog',
  settingsNav: '.settings-nav, [data-testid="settings-nav"], [role="tablist"]',
  settingsPane: '.settings-pane, [data-testid="settings-pane"], [role="tabpanel"]',
  settingsTrigger: '[data-testid="settings-gear"], .gear-icon, .settings-trigger, button[aria-label*="settings" i]',
} as const;
