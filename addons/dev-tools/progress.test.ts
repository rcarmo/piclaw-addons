import { expect, test } from "bun:test";
import { withDevToolProgress } from "./index.js";

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

test("dev tool progress restores default UI after success", async () => {
  const { calls, ctx } = uiHarness();
  const result = await withDevToolProgress(ctx, "Working…", async () => 42);
  expect(result).toBe(42);
  expect(calls[0]?.[0]).toBe("indicator");
  expect(calls[1]).toEqual(["message", "Working…"]);
  expect(calls[2]).toEqual(["message", undefined]);
  expect(calls[3]).toEqual(["indicator", undefined]);
});

test("dev tool progress restores default UI after failure", async () => {
  const { calls, ctx } = uiHarness();
  await expect(withDevToolProgress(ctx, "Working…", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(calls.slice(-2)).toEqual([["message", undefined], ["indicator", undefined]]);
});

test("dev tool progress is a no-op without UI", async () => {
  const { calls, ctx } = uiHarness(false);
  await withDevToolProgress(ctx, "Working…", async () => undefined);
  expect(calls).toEqual([]);
});
