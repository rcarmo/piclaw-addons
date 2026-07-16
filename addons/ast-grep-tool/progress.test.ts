import { expect, test } from "bun:test";
import { finishAstGrepProgress, startAstGrepProgress, withAstGrepProgress } from "./index.js";

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

test("ast-grep progress starts with a message and restores default UI", () => {
  const { calls, ctx } = uiHarness();
  startAstGrepProgress(ctx, "Searching…");
  finishAstGrepProgress(ctx);

  expect(calls[0]?.[0]).toBe("indicator");
  expect(calls[0]?.[1]).toMatchObject({ intervalMs: 90 });
  expect(calls[1]).toEqual(["message", "Searching…"]);
  expect(calls[2]).toEqual(["message", undefined]);
  expect(calls[3]).toEqual(["indicator", undefined]);
});

test("ast-grep progress restores default UI after failure", async () => {
  const { calls, ctx } = uiHarness();
  await expect(withAstGrepProgress(ctx, "Searching…", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(calls.slice(-2)).toEqual([["message", undefined], ["indicator", undefined]]);
});

test("ast-grep progress is a no-op without UI", () => {
  const { calls, ctx } = uiHarness(false);
  startAstGrepProgress(ctx, "Searching…");
  finishAstGrepProgress(ctx);
  expect(calls).toEqual([]);
});
