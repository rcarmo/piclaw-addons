import { expect } from "../../../../tests/addon-e2e/support/world";
import type { StepDefinition } from "../../../../tests/addon-e2e/support/gherkin-runner";

export const steps: StepDefinition[] = [
  {
    pattern: /^Remote Peer is reset to disabled direct-only settings$/,
    async handler(ctx) {
      const response = await ctx.page.request.post(
        "/agent/addons/api/remote-peer/config",
        {
          data: {
            enabled: false,
            instanceName: "E2E Remote Peer",
            mdnsEnabled: false,
            mdnsInterface: "",
            addressLookup: false,
            relayMode: "disabled",
            relays: [],
          },
        },
      );
      expect(response.ok(), await response.text()).toBeTruthy();
    },
  },
  {
    pattern: /^I should see a checksummed Remote Peer client ID$/,
    async handler(ctx) {
      await expect(
        ctx.page
          .locator("code")
          .filter({ hasText: /^PCL1-(?:[A-F0-9]{8}-){8}[A-F0-9]{8}$/ })
          .first(),
      ).toBeVisible();
    },
  },
  {
    pattern: /^the Remote Peer client-ID pairing field should be available$/,
    async handler(ctx) {
      await expect(ctx.page.getByLabel("Peer client ID")).toBeVisible();
      await expect(
        ctx.page.getByRole("button", { name: "Request pairing" }),
      ).toBeVisible();
    },
  },
  {
    pattern: /^Remote Peer mDNS should be off$/,
    async handler(ctx) {
      await expect(
        ctx.page.getByRole("checkbox", { name: /Enable mDNS/ }),
      ).not.toBeChecked();
    },
  },
  {
    pattern: /^Remote Peer internet address lookup should be off$/,
    async handler(ctx) {
      await expect(
        ctx.page.getByRole("checkbox", { name: /Internet address lookup/ }),
      ).not.toBeChecked();
    },
  },
  {
    pattern: /^I enable Remote Peer in Settings$/,
    async handler(ctx) {
      await ctx.page
        .getByRole("checkbox", { name: "Enable Remote Peer", exact: true })
        .check();
    },
  },
  {
    pattern: /^I disable Remote Peer in Settings$/,
    async handler(ctx) {
      await ctx.page
        .getByRole("checkbox", { name: "Enable Remote Peer", exact: true })
        .uncheck();
    },
  },
  {
    pattern: /^Remote Peer should report "([^"]+)"$/,
    async handler(ctx, status) {
      await expect(
        ctx.page.getByText(new RegExp(`^${status}\\s*·`)),
      ).toBeVisible({ timeout: 15_000 });
    },
  },
];
