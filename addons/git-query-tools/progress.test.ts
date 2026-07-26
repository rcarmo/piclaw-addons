import { expect, test } from "bun:test";
import { GitHistoryToolSchema, withGitQueryProgress } from "./supervisor.js";

test("git history mode uses a Google-compatible string enum", () => {
  expect(GitHistoryToolSchema.properties.mode).toMatchObject({
    type: "string",
    enum: ["log", "content_search", "message_search", "blame"],
  });
});

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

test("git query progress restores default UI after success", async () => {
  const { calls, ctx } = uiHarness();
  expect(await withGitQueryProgress(ctx, "Working…", async () => "ok")).toBe("ok");
  expect(calls).toHaveLength(4);
  expect(calls[1]).toEqual(["message", "Working…"]);
  expect(calls.slice(-2)).toEqual([["message", undefined], ["indicator", undefined]]);
});

test("git query progress restores default UI after failure", async () => {
  const { calls, ctx } = uiHarness();
  await expect(withGitQueryProgress(ctx, "Working…", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(calls.slice(-2)).toEqual([["message", undefined], ["indicator", undefined]]);
});

test("git query progress is a no-op without UI", async () => {
  const { calls, ctx } = uiHarness(false);
  await withGitQueryProgress(ctx, "Working…", async () => undefined);
  expect(calls).toEqual([]);
});
