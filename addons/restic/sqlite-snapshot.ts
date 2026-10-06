import { DatabaseSync, backup } from 'node:sqlite';
import { lstatSync } from 'node:fs';

/** Separate Bun worker: page-batched backup preserves implicit row IDs and committed WAL. */
export async function snapshotDatabase(source: string, destination: string): Promise<void> {
  const before = lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('SQLite source is not a regular file');
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const opened = lstatSync(source);
    if (opened.isSymbolicLink() || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error('SQLite source changed while opening');
    db.exec('PRAGMA busy_timeout=5000; PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA temp_store=FILE;');
    await backup(db, destination, { rate: 128 });
  } finally { db.close(); }
  const after = lstatSync(source);
  if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) throw new Error('SQLite source changed during snapshot');
  const copy = new DatabaseSync(destination);
  try {
    copy.exec('PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA journal_mode=DELETE;');
    const rows = copy.prepare('PRAGMA quick_check(5)').all();
    if (!rows.length || rows.some(row => Object.values(row)[0] !== 'ok')) {
      throw new Error('SQLite snapshot quick_check failed: ' + rows.map(row => Object.values(row)[0]).join('; '));
    }
  } finally { copy.close(); }
}

if (import.meta.main) {
  const [source, destination] = process.argv.slice(2);
  try {
    if (!source || !destination) throw new Error('Invalid snapshot arguments');
    await snapshotDatabase(source, destination);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
