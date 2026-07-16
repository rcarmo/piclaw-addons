import { expect, test } from "bun:test";
import {
  finishDiagnosticsProgress,
  startDiagnosticsProgress,
  updateDiagnosticsProgress,
  withDiagnosticsProgress,
} from "./index.ts";

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

test("diagnostics progress updates messages and restores default UI", () => {
  const { calls, ctx } = uiHarness();
  startDiagnosticsProgress(ctx, "Validating…");
  updateDiagnosticsProgress(ctx, "Running oxlint…");
  finishDiagnosticsProgress(ctx);

  expect(calls[0]?.[0]).toBe("indicator");
  expect(calls[1]).toEqual(["message", "Validating…"]);
  expect(calls[2]).toEqual(["message", "Running oxlint…"]);
  expect(calls[3]).toEqual(["message", undefined]);
  expect(calls[4]).toEqual(["indicator", undefined]);
});

test("diagnostics progress restores default UI after failure", async () => {
  const { calls, ctx } = uiHarness();
  await expect(withDiagnosticsProgress(ctx, "Validating…", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(calls.slice(-2)).toEqual([["message", undefined], ["indicator", undefined]]);
});

test("diagnostics progress is a no-op without UI", () => {
  const { calls, ctx } = uiHarness(false);
  startDiagnosticsProgress(ctx, "Validating…");
  updateDiagnosticsProgress(ctx, "Running…");
  finishDiagnosticsProgress(ctx);
  expect(calls).toEqual([]);
});
