import { assertTestWorkspaceArguments, ensureTestFilesystemIsolation } from "./lib/test-filesystem-isolation.js";
ensureTestFilesystemIsolation();
assertTestWorkspaceArguments(process.argv.slice(2));
await import('./check-test-preloads.js');
