import { expect, test } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';
import { createPipeChannel } from './pipe.ts';
import { LIMITS } from './contracts.ts';

test('pipe copies frames, propagates backpressure and bounds pending writes', async () => {
  const input = new PassThrough(); let callback!: (error?: Error | null) => void, captured!: Buffer, lost = 0;
  const output = new Writable({ highWaterMark: 1, write(bytes, _encoding, done) { captured = bytes; callback = done; } });
  const channel = createPipeChannel(input, output, { data() {}, lost() { lost++; } });
  const bytes = Buffer.from('one'); let completed = false;
  const first = channel.send(bytes, new AbortController().signal).then(() => { completed = true; });
  bytes.fill(0); await Promise.resolve(); expect(completed).toBe(false); expect(captured.toString()).toBe('one');
  callback(); await first; expect(completed).toBe(true);
  const second = channel.send(Buffer.from('two'), new AbortController().signal);
  const third = channel.send(Buffer.from('three'), new AbortController().signal);
  await expect(channel.send(Buffer.from('four'), new AbortController().signal)).rejects.toThrow('LIMIT');
  await expect(second).rejects.toThrow('REQUEST_FAILED'); await expect(third).rejects.toThrow('REQUEST_FAILED');
  channel.close(); expect(lost).toBe(1);
});

test('pipe rejects oversized frames, abort/EOF and malformed inbound once without reflecting diagnostics', async () => {
  for (const mode of ['size', 'abort', 'eof', 'parse']) {
    const input = new PassThrough(), output = new Writable({ write() {} }); let lost = 0;
    const channel = createPipeChannel(input, output, { data() { throw Error('PRIVATE'); }, lost() { lost++; } });
    if (mode === 'size') await expect(channel.send(Buffer.alloc(LIMITS.frameBytes + 5), new AbortController().signal)).rejects.toThrow('LIMIT');
    else {
      const aborter = new AbortController(), pending = channel.send(Buffer.from('test'), aborter.signal);
      if (mode === 'abort') aborter.abort();
      if (mode === 'eof') input.emit('end');
      if (mode === 'parse') input.write('bad');
      await expect(pending).rejects.toThrow('REQUEST_FAILED');
    }
    channel.close(); expect(lost).toBe(1); expect(input.destroyed).toBe(true); expect(output.destroyed).toBe(true);
  }
});
