import { expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PeerService } from './service.js';
import { runAction } from './actions.js';
import { RemotePeerAuthorityScope } from './native-authority.js';
import type { Peer } from './state.js';

function fixture(authority?: RemotePeerAuthorityScope) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-storage-service-')); let sends = 0;
  const service = new PeerService({ dataDir: dir, authority,
    runtime: { messaging: { listAdvertisableAgents: async () => [] } } as any,
    transportFactory: () => ({ id: '11'.repeat(32), clientId: 'local', close: async () => {}, start: async () => {}, status: () => ({ active: false }),
      request: async (_peer: string, operation: string, body: any) => { expect(operation).toBe('message'); sends++; return { body: { messageId: body.messageId, status: 'queued' } }; },
    }) as any,
  });
  const peer: Peer = { id: '22'.repeat(32), alias: 'lab', name: 'Lab', status: 'paired', request: 'pair', epoch: 'epoch', expires: Date.now() + 60000, ticket: null, scope: 'inbox-only', agents: [], modes: ['queue'], files: false, lastSeen: null };
  service.state.saveConfig({ ...service.state.config(), enabled: true }); service.state.put(peer);
  return { dir, service, peer, path: join(service.state.dir, 'peers.db'), sends: () => sends };
}

test('actual outbound service waits for storage admission before transport and deduplicates its delivered receipt', async () => {
  const f = fixture(), blocker = new Database(f.path);
  blocker.exec('BEGIN IMMEDIATE'); let settled = false, beats = 0;
  const pulse = setInterval(() => { beats++; }, 5);
  const request = { address: { peer: 'lab', target: 'inbox' }, source_chat_jid: 'web:fixture', content: 'fixture', mode: 'queue', attachments: [], idempotency_key: 'one' } as any;
  const pending = f.service.send(request).then(value => { settled = true; return value; });
  try {
    await Bun.sleep(50); expect(settled).toBe(false); expect(f.sends()).toBe(0); expect(beats).toBeGreaterThan(1);
    expect(blocker.query('SELECT * FROM outbound').all()).toEqual([]);
    blocker.exec('ROLLBACK');
    expect(await pending).toHaveProperty('relayed', true); expect(f.sends()).toBe(1);
    expect(await f.service.send(request)).toHaveProperty('relayed', true); expect(f.sends()).toBe(1);
    expect(f.service.state.db.query('SELECT status,bytes FROM outbound').all()).toEqual([{ status: 'delivered', bytes: null }]);
  } finally { if (blocker.inTransaction) blocker.exec('ROLLBACK'); await pending.catch(() => {}); clearInterval(pulse); blocker.close(); await f.service.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('an actual operator action returns a classified storage timeout without blocking unrelated timers', async () => {
  const f = fixture(), blocker = new Database(f.path); blocker.exec('BEGIN IMMEDIATE');
  let beats = 0; const pulse = setInterval(() => { beats++; }, 10);
  try {
    const result = await runAction({ action: 'alias', peer: 'lab', alias: 'new-alias' }, f.service).then(() => undefined, error => error);
    expect(result).toHaveProperty('code', 'PEER_STATE_BUSY'); expect(result).toHaveProperty('certainty', 'not_applied'); expect(beats).toBeGreaterThan(50);
    expect(f.service.state.peer(f.peer.id)!.alias).toBe('lab'); expect(f.sends()).toBe(0);
    blocker.exec('ROLLBACK'); await runAction({ action: 'alias', peer: 'lab', alias: 'new-alias' }, f.service);
    expect(f.service.state.peer(f.peer.id)!.alias).toBe('new-alias');
  } finally { clearInterval(pulse); if (blocker.inTransaction) blocker.exec('ROLLBACK'); blocker.close(); await f.service.close(); rmSync(f.dir, { recursive: true, force: true }); }
}, 10000);

test('policy comparison runs after acquisition and cannot overwrite a concurrent narrowing', async () => {
  const f = fixture(), blocker = new Database(f.path); blocker.exec('BEGIN IMMEDIATE');
  const expected = { scope: f.peer.scope, modes: f.peer.modes, agents: f.peer.agents, files: f.peer.files };
  try {
    const pending = f.service.setPolicy('lab', { ...expected, files: true, confirmation: 'ALLOW REMOTE ACCESS', expected_epoch: f.peer.epoch, expected_policy: expected });
    const observed = pending.then(() => undefined, error => error);
    await Bun.sleep(20);
    const narrowed = { ...f.peer, scope: 'none', modes: ['queue'] };
    blocker.query('UPDATE peers SET data=? WHERE id=?').run(JSON.stringify(narrowed), f.peer.id);
    blocker.query('INSERT OR REPLACE INTO settings VALUES(?,?)').run('grant-epoch:' + f.peer.id, 'concurrent-revision'); blocker.exec('COMMIT');
    expect(await observed).toHaveProperty('message', 'Saved permissions or pairing changed. Revert to reload before applying.');
    expect(f.service.state.peer(f.peer.id)).toEqual(narrowed); expect(f.sends()).toBe(0);
  } finally { if (blocker.inTransaction) blocker.exec('ROLLBACK'); blocker.close(); await f.service.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('service close aborts an unentered action without publishing a later stale mutation', async () => {
  const f = fixture(), blocker = new Database(f.path); blocker.exec('BEGIN IMMEDIATE');
  try {
    const pending = runAction({ action: 'alias', peer: 'lab', alias: 'must-not-write' }, f.service);
    const observed = pending.then(() => undefined, error => error);
    await Bun.sleep(20); await f.service.close();
    expect(await observed).toHaveProperty('message', 'Peer state closed.');
    expect(JSON.parse((blocker.query('SELECT data FROM peers WHERE id=?').get(f.peer.id) as any).data).alias).toBe('lab'); expect(f.sends()).toBe(0);
  } finally { blocker.exec('ROLLBACK'); blocker.close(); await f.service.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('authorised incoming revocation commits atomically even though it invalidates its own peer grant', async () => {
  let f: ReturnType<typeof fixture>;
  const authority = new RemotePeerAuthorityScope({ assertCurrent() {}, assertPeerCurrent(source) { f.service.assertNativePeerCurrent(source); } });
  f = await authority.application('setup', async () => fixture(authority));
  try {
    await authority.application('seed', async () => { f.service.state.db.query('INSERT INTO replies VALUES(?,?,?,?,?)').run('capability', f.peer.id, f.peer.epoch, 'web:fixture', Date.now() + 60000); });
    const response = await authority.incoming({ peer: f.peer.id, revision: f.peer.epoch, operation: 'revoke' }, () => f.service.receive(f.peer.id, { op: 'revoke', body: { epoch: f.peer.epoch } } as any, new Uint8Array()));
    expect(response.body).toEqual({ ok: true });
    await authority.application('inspect', async () => {
      expect(f.service.state.peer(f.peer.id)!.status).toBe('revoked');
      expect(f.service.state.db.query('SELECT * FROM replies WHERE peer=?').all(f.peer.id)).toEqual([]);
    });
  } finally { await authority.application('close', () => f.service.close()); rmSync(f.dir, { recursive: true, force: true }); }
});

test('native invocation revocation cancels a real service SQL wait before its body can mutate', async () => {
  let current = true;
  const authority = new RemotePeerAuthorityScope({ assertCurrent() { if (!current) throw Error('Owner revoked'); } });
  const f = await authority.application('setup', async () => fixture(authority));
  const blocker = new Database(f.path); blocker.exec('BEGIN IMMEDIATE');
  try {
    const pending = authority.application('alias', () => runAction({ action: 'alias', peer: 'lab', alias: 'must-not-write' }, f.service));
    const observed = pending.then(() => undefined, error => error);
    await Bun.sleep(25); current = false;
    expect(await observed).toHaveProperty('message', 'Owner revoked'); expect(blocker.inTransaction).toBe(true);
    expect(JSON.parse((blocker.query('SELECT data FROM peers WHERE id=?').get(f.peer.id) as any).data).alias).toBe('lab');
    expect(f.sends()).toBe(0);
  } finally { current = true; blocker.exec('ROLLBACK'); blocker.close(); await authority.application('close', () => f.service.close()); rmSync(f.dir, { recursive: true, force: true }); }
});
