import { expect, test } from "bun:test";
import { describeImapAction, finishImapProgress, startImapProgress } from "./index.ts";

function uiHarness(hasUI = true) {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    ctx: {
      hasUI,
      ui: {
        setWorkingIndicator(value?: unknown) { calls.push(["indicator", value]); },
        setWorkingMessage(value?: unknown) { calls.push(["message", value]); },
      },
    } as any,
  };
}

test("IMAP action descriptions include useful account and folder context", () => {
  expect(describeImapAction("search", { account: "work", folder: "Archive" })).toBe("IMAP: searching Archive (work)…");
  expect(describeImapAction("fetch", {})).toBe("IMAP: fetching messages from INBOX…");
  expect(describeImapAction("list_accounts", {})).toBe("IMAP: listing accounts…");
});

test("IMAP progress restores default UI", () => {
  const { calls, ctx } = uiHarness();
  startImapProgress(ctx, "IMAP: searching…");
  finishImapProgress(ctx);
  expect(calls[0]?.[0]).toBe("indicator");
  expect(calls[1]).toEqual(["message", "IMAP: searching…"]);
  expect(calls.slice(-2)).toEqual([["message", undefined], ["indicator", undefined]]);
});

test("IMAP progress is a no-op without UI", () => {
  const { calls, ctx } = uiHarness(false);
  startImapProgress(ctx, "IMAP: searching…");
  finishImapProgress(ctx);
  expect(calls).toEqual([]);
});
