import { expect, test } from "bun:test";
import { join } from "node:path";

// A fresh process cannot inherit the web-tree-sitter mock from index.test.ts.
test("real web-tree-sitter 0.27.1 loads Bash WASM and conservatively parses commands", () => {
  const script = `
    import { expect } from "bun:test";
    import { createRequire } from "node:module";
    import { hasBashAstSupport, prepareBashParser, tryParseShell, parseShellLcPlainCommands, parseShellLcSingleCommandPrefix } from "./src/shell/bash.ts";
    import { summarizeShellCommand } from "./src/shell/summary.ts";
    const require = createRequire(import.meta.url);
    expect(require("web-tree-sitter/package.json").version).toBe("0.27.1");
    expect(hasBashAstSupport()).toBe(false);
    expect(summarizeShellCommand("bash -lc 'cat README.md'").actions).toEqual([{ kind: "run", command: "cat README.md" }]);
    const prepared = prepareBashParser();
    expect(prepareBashParser()).toBe(prepared);
    expect(await prepared).toBe(true);
    expect(hasBashAstSupport()).toBe(true);
    const tree = tryParseShell("echo hello && printf '%s' world | cat");
    expect(tree).toBeDefined();
    expect(tree.rootNode.hasError).toBe(false);
    expect(parseShellLcPlainCommands(["bash", "-lc", "echo hello && printf '%s' world | cat"])).toEqual([["echo", "hello"], ["printf", "%s", "world"], ["cat"]]);
    for (const script of ["echo $HOME", "echo $(whoami)", "echo ok > out", "echo ok &"]) {
      expect(parseShellLcPlainCommands(["bash", "-lc", script])).toBeUndefined();
    }
    expect(parseShellLcSingleCommandPrefix(["bash", "-lc", "cat <<EOF" + String.fromCharCode(10) + "hello" + String.fromCharCode(10) + "EOF"])).toEqual(["cat"]);
    expect(summarizeShellCommand("bash -lc 'cat README.md'").actions).toEqual([{ kind: "read", command: "cat README.md", name: "README.md", path: "README.md" }]);
    console.log("PASS real Bash AST WASM 0.27.1: initialization, pipeline, unsafe syntax, heredoc");
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], { cwd: import.meta.dir, env: process.env, stdout: "pipe", stderr: "pipe" });
  console.log(result.stdout.toString());
  if (result.exitCode !== 0) console.error(result.stderr.toString());
  expect(result.exitCode).toBe(0);
}, 30000);
