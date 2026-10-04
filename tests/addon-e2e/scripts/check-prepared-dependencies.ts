import { realpathSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, sep, join } from "node:path";

export function checkPreparedDependencies(root: string, workspace: string) {
  if (!root.startsWith("/tmp/piclaw-addon-e2e-")) throw Error("Explicit prepared fixture required");
  const ownedRoot = realpathSync(root);
  const remotePeer = join(workspace, ".pi/extensions/node_modules/@rcarmo/piclaw-addon-remote-peer");
  if (lstatSync(remotePeer).isSymbolicLink()) throw Error("Prepared add-on must be owned source copy");
  const privateModules = join(remotePeer, "node_modules");
  const privateStat = lstatSync(privateModules);
  if (!privateStat.isDirectory() || privateStat.isSymbolicLink()) throw Error("Remote Peer requires a private dependency directory");
  const ownedPrivate = realpathSync(privateModules);
  const inside = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
  };
  if (!inside(ownedRoot, ownedPrivate)) throw Error("Private dependencies escape fixture");
  const resolved = [];
  for (const name of ["@earendil-works/pi-ai", "partial-json", "@number0/iroh", "bonjour-service"]) {
    const path = realpathSync(Bun.resolveSync(name, remotePeer));
    if (!inside(ownedRoot, path)) throw Error(`Prepared dependency escapes owned fixture: ${name}`);
    if (["@number0/iroh", "bonjour-service"].includes(name) && !inside(ownedPrivate, path)) throw Error(`Runtime dependency missing from private install: ${name}`);
    resolved.push({ name, path: relative(ownedRoot, path) });
  }
  const aiRoot = realpathSync(Bun.resolveSync("@earendil-works/pi-ai", remotePeer));
  const partial = realpathSync(Bun.resolveSync("partial-json", dirname(aiRoot)));
  if (!inside(ownedRoot, partial)) throw Error("Peer transitive dependency escaped fixture");
  return { preparedDependencies: "pass", resolved };
}
if (import.meta.main) {
  const root = process.env.PICLAW_PREP_ROOT, workspace = process.env.PICLAW_WORKSPACE;
  if (!root || !workspace) throw Error("Explicit prepared fixture required");
  console.log(JSON.stringify(checkPreparedDependencies(root, workspace)));
}
