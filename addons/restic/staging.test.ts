import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { stageSources, verifyRestore } from "./staging.ts";

function fixtureRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}
function cloneDirectory(source: string, target: string): void {
  cpSync(source, target, { recursive: true, force: true, dereference: false, verbatimSymlinks: true });
}

test("stages nested files, excludes globs, preserves safe symlinks, and snapshots committed WAL rows", async () => {
  const root = fixtureRoot("restic-stage");
  const sourceA = join(root, "source-a");
  const sourceB = join(root, "source-b");
  const staging = join(root, "staging");
  mkdirSync(join(sourceA, "nested"), { recursive: true });
  mkdirSync(join(sourceA, "skip-dir"), { recursive: true });
  mkdirSync(sourceB, { recursive: true });
  writeFileSync(join(sourceA, "keep.txt"), "keep me\n");
  writeFileSync(join(sourceA, "nested", "child.txt"), "nested\n");
  writeFileSync(join(sourceA, "nested", "skip.tmp"), "skip me\n");
  writeFileSync(join(sourceA, "skip-dir", "ignored.txt"), "ignored\n");
  symlinkSync("nested/child.txt", join(sourceA, "link.txt"));
  writeFileSync(join(sourceB, "standalone-wal"), "durable sidecar lookalike\n");

  const liveDb = join(sourceB, "live.custom");
  const writer = new Database(liveDb);
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items(value INTEGER); INSERT INTO items VALUES (1);");
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writer.exec("INSERT INTO items VALUES (2)");
    expect(existsSync(`${liveDb}-wal`)).toBe(true);

    const rawCopy = join(root, "raw-copy.db");
    writeFileSync(rawCopy, readFileSync(liveDb));
    const rawDb = new Database(rawCopy, { readonly: true });
    expect(rawDb.query("SELECT count(*) AS count FROM items").get()).toEqual({ count: 1 });
    rawDb.close();

    const result = await stageSources([
      { name: "alpha", path: sourceA },
      { name: "beta", path: sourceB },
    ], staging, ["**/*.tmp", "alpha/skip-dir/**"]);

    expect(result.directory).toBe(staging);
    expect(result.manifest.sources).toEqual([
      { name: "alpha", path: sourceA },
      { name: "beta", path: sourceB },
    ]);
    expect(result.manifest.files.map(file => file.path)).toEqual([
      "alpha/keep.txt",
      "alpha/link.txt",
      "alpha/nested/child.txt",
      "beta/live.custom",
      "beta/standalone-wal",
    ]);
    expect(existsSync(join(staging, "beta", "live.custom-wal"))).toBe(false);
    expect(existsSync(join(staging, "beta", "live.custom-shm"))).toBe(false);
    expect(existsSync(join(staging, "alpha", "skip-dir", "ignored.txt"))).toBe(false);
    expect(readFileSync(join(staging, "alpha", "keep.txt"), "utf8")).toBe("keep me\n");
    expect(readFileSync(join(staging, "beta", "standalone-wal"), "utf8")).toBe("durable sidecar lookalike\n");
    expect(readlinkSync(join(staging, "alpha", "link.txt"))).toBe("nested/child.txt");

    const stagedDb = new Database(join(staging, "beta", "live.custom"), { readonly: true });
    expect(stagedDb.query("SELECT count(*) AS count FROM items").get()).toEqual({ count: 2 });
    stagedDb.close();

    await expect(verifyRestore(staging)).resolves.toEqual({ files: 5, databases: 1 });
    result.cleanup();
    expect(existsSync(staging)).toBe(false);
  } finally {
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for missing sources, overlap, pre-existing staging, and cancellation", async () => {
  const root = fixtureRoot("restic-stage-errors");
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "file.txt"), "data\n");
  try {
    await expect(stageSources([{ name: "missing", path: join(root, "missing") }], join(root, "stage-missing"), [])).rejects.toThrow();
    await expect(stageSources([{ name: "source", path: source }], join(source, ".restic-stage"), [])).rejects.toThrow("overlaps");
    mkdirSync(join(root, "stage-exists"));
    await expect(stageSources([{ name: "source", path: source }], join(root, "stage-exists"), [])).rejects.toThrow("already exists");
    const controller = new AbortController();
    controller.abort();
    const cancelled = join(root, "stage-cancelled");
    await expect(stageSources([{ name: "source", path: source }], cancelled, [], controller.signal)).rejects.toThrow(/aborted/i);
    expect(existsSync(cancelled)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyRestore rejects tampered files, manifest traversal, and symlink escapes", async () => {
  const root = fixtureRoot("restic-verify");
  const source = join(root, "source");
  const staging = join(root, "staging");
  mkdirSync(join(source, "nested"), { recursive: true });
  writeFileSync(join(source, "nested", "file.txt"), "original\n");
  symlinkSync("nested/file.txt", join(source, "link.txt"));
  const result = await stageSources([{ name: "safe", path: source }], staging, []);
  try {
    const tamperedFile = join(root, "tampered-file");
    cloneDirectory(staging, tamperedFile);
    expect(readlinkSync(join(tamperedFile, "safe", "link.txt"))).toBe("nested/file.txt");
    writeFileSync(join(tamperedFile, "safe", "nested", "file.txt"), "changed\n");
    await expect(verifyRestore(tamperedFile)).rejects.toThrow("hash mismatch");

    const tamperedManifest = join(root, "tampered-manifest");
    cloneDirectory(staging, tamperedManifest);
    const manifestPath = join(tamperedManifest, ".restic-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files[0].path = "../escape.txt";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(verifyRestore(tamperedManifest)).rejects.toThrow("manifest path is invalid");

    const tamperedSymlink = join(root, "tampered-symlink");
    cloneDirectory(staging, tamperedSymlink);
    rmSync(join(tamperedSymlink, "safe", "link.txt"), { force: true });
    symlinkSync("../../outside.txt", join(tamperedSymlink, "safe", "link.txt"));
    await expect(verifyRestore(tamperedSymlink)).rejects.toThrow("escapes");
  } finally {
    result.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects symlinked ancestors and manifests; staging rejects source alias escape',async()=>{
 const root=fixtureRoot('restic-symlink-');const source=join(root,'source'),staging=join(root,'staging'),outside=join(root,'outside');
 mkdirSync(source);mkdirSync(outside);writeFileSync(join(outside,'secret'),'outside');
 symlinkSync(outside,join(source,'dir'));symlinkSync('dir/secret',join(source,'link'));
 try{
  await expect(stageSources([{name:'s',path:source}],staging,[])).rejects.toThrow();
  rmSync(join(source,'dir'));rmSync(join(source,'link'));writeFileSync(join(source,'safe'),'ok');
  const staged=await stageSources([{name:'s',path:source}],staging,[]);
  try{const alias=join(root,'alias');symlinkSync(staging,alias);await expect(verifyRestore(alias)).rejects.toThrow('real directory');
   const manifest=join(staging,'.restic-manifest.json');const saved=join(root,'manifest.json');writeFileSync(saved,readFileSync(manifest));rmSync(manifest);symlinkSync(saved,manifest);await expect(verifyRestore(staging)).rejects.toThrow('regular file');
  }finally{staged.cleanup();}
 }finally{rmSync(root,{recursive:true,force:true});}
});
