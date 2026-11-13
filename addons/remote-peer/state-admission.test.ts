import { expect, spyOn, test } from 'bun:test';
import Database from 'bun:sqlite';
import { mkdtempSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerState } from './state.js';

function fixture(assertCurrent?: () => void) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-sql-')), state = new PeerState(dir, undefined, assertCurrent);
  return { dir, state, path: join(state.dir, 'peers.db'), close() { state.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('peer SQL acquisition yields behind a writer held beyond five seconds and enters its body once', async () => {
  const f = fixture(), blocker = new Database(f.path);
  blocker.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  let beats = 0, calls = 0;
  const timer = setInterval(() => { beats++; }, 10);
  const unlock = setTimeout(() => blocker.exec('ROLLBACK'), 6100);
  try {
    await f.state.write(() => { calls++; f.state.db.query("INSERT INTO settings VALUES('fixture','retained')").run(); }, { timeoutMs: 9000 });
    expect(calls).toBe(1); expect(beats).toBeGreaterThan(50);
    expect(f.state.db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 0 });
    expect(f.state.db.query("SELECT value FROM settings WHERE key='fixture'").get()).toEqual({ value: 'retained' });
    f.state.close();
    const reopened = new PeerState(f.dir);
    try { expect(reopened.db.query("SELECT value FROM settings WHERE key='fixture'").get()).toEqual({ value: 'retained' }); }
    finally { reopened.close(); }
  } finally { clearInterval(timer); clearTimeout(unlock); if (blocker.inTransaction) blocker.exec('ROLLBACK'); blocker.close(); f.close(); }
}, 15000);

for (const mode of ['abort', 'revoke', 'close'] as const) test(`pending peer SQL ${mode} never enters a stale body`, async () => {
  let current = true, calls = 0;
  const f = fixture(() => { if (!current) throw Error('Peer owner revoked'); }), blocker = new Database(f.path), controller = new AbortController();
  blocker.exec('BEGIN IMMEDIATE');
  try {
    const pending = f.state.write(() => { calls++; }, { signal: controller.signal });
    const observed = pending.then(() => undefined, error => error);
    await Bun.sleep(20);
    if (mode === 'abort') controller.abort(Error('Cancelled fixture'));
    if (mode === 'revoke') current = false;
    if (mode === 'close') f.state.close();
    expect(await observed).toBeInstanceOf(Error); expect(calls).toBe(0); expect(blocker.inTransaction).toBe(true);
  } finally { blocker.exec('ROLLBACK'); blocker.close(); f.close(); }
});

test('a lock becoming available after the acquisition deadline cannot admit a late body', async () => {
  const f = fixture(), blocker = new Database(f.path); blocker.exec('BEGIN IMMEDIATE');
  let now = 0, calls = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  try {
    const pending = f.state.write(() => { calls++; }, { timeoutMs: 100 });
    const observed = pending.then(() => undefined, error => error);
    await Bun.sleep(5); now = 101; blocker.exec('ROLLBACK');
    expect(await observed).toHaveProperty('code', 'PEER_STATE_BUSY'); expect(calls).toBe(0);
  } finally { clock.mockRestore(); if (blocker.inTransaction) blocker.exec('ROLLBACK'); blocker.close(); f.close(); }
});

test('entered peer SQL callbacks are rolled back but never retried, even when they throw BUSY', async () => {
  const f = fixture(); let calls = 0;
  try {
    const original = Object.assign(Error('entered callback fault'), { code: 'SQLITE_BUSY' });
    await expect(f.state.write(() => { calls++; f.state.db.query("INSERT INTO settings VALUES('never','commit')").run(); throw original; })).rejects.toBe(original);
    expect(calls).toBe(1); expect(f.state.db.query("SELECT * FROM settings WHERE key='never'").all()).toEqual([]);
    for (const timeoutMs of [0, -1, NaN, Infinity]) await expect(f.state.write(() => { calls++; }, { timeoutMs })).rejects.toThrow('finite and positive');
    expect(calls).toBe(1);
  } finally { f.close(); }
});

test('peer state refuses an already-open moved descriptor before a new mutation', async () => {
  const f = fixture(), old = f.path + '.original'; let replacement: Database | undefined, calls = 0;
  try {
    f.state.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); renameSync(f.path, old);
    replacement = new Database(f.path); replacement.exec('PRAGMA journal_mode=WAL');
    await expect(f.state.write(() => { calls++; })).rejects.toThrow('identity changed'); expect(calls).toBe(0);
  } finally { replacement?.close(); rmSync(f.path, { force: true }); renameSync(old, f.path); f.close(); }
});
