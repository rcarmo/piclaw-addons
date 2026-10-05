// Disposable hostile-child fixture. No real credentials or external endpoints.
import { readFileSync, existsSync, writeFileSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { Socket } from 'node:net';
const mode = process.argv[2];
if (mode === 'agent') {
  await import('./fixture-child.ts');
} else {
  const denied: Record<string, boolean> = {};
  for (const path of ['/outside-canary', '/workspace/.piclaw', '/workspace/.pi', '/run', '/home/agent/.pi', '/etc/passwd', '/proc/2/root/outside-canary', '/proc/1/root/outside-canary']) {
    try { readFileSync(path); denied[path] = false; } catch { denied[path] = true; }
  }
  let workWrite = false;
  try { writeFileSync('/work/changed.txt', 'child output'); workWrite = true; } catch {}
  let workOverwrite = false;
  try { writeFileSync('/work/fixture.txt', 'SYNTHETIC_APPROVED_INPUT'); workOverwrite = true; } catch {}
  let symlinkEscape = false;
  try { symlinkSync(process.argv[3]!, '/tmp/host-link'); readFileSync('/tmp/host-link'); symlinkEscape = true; } catch {}
  let runtimeWrite = false;
  try { writeFileSync('/app/escape', 'bad'); runtimeWrite = true; } catch {}
  let tempWrite = false;
  try { writeFileSync('/tmp/allowed', 'yes'); tempWrite = true; } catch {}
  const status = readFileSync('/proc/self/status', 'utf8');
  const network = await new Promise<string>(resolve => {
    const socket = new Socket(); socket.once('error', e => resolve((e as any).code ?? 'error'));
    socket.connect({ host: '127.0.0.1', port: 9 }, () => { resolve('CONNECTED'); socket.destroy(); });
  });
  const sockets = await new Promise<string>(resolve => {
    const socket = new Socket(); socket.once('error', e => resolve((e as any).code ?? 'error'));
    socket.connect('/work/provider.sock', () => { resolve('CONNECTED'); socket.destroy(); });
  });
  const bash = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', 'set -e; cat /work/fixture.txt; test ! -e /workspace/.piclaw; echo BASH_OK'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/home' } });
  const escape = spawnSync('/bin/probe', [], { encoding: 'utf8' });
  if (mode === 'daemon' || mode === 'daemon-exit') {
    const descendant = spawn('/usr/bin/setsid', ['/bin/bash', '-c', 'trap "" TERM; while :; do sleep 1; done'], { stdio: 'ignore' });
    descendant.unref();
    console.log(JSON.stringify({ daemonNamespacePid: descendant.pid }));
    // Normal init exit and killed supervisor must both end detached descendants.
    if (mode === 'daemon-exit') setTimeout(() => process.exit(0), 500);
    else setInterval(() => {}, 1000);
  } else {
    console.log(JSON.stringify({ denied, workWrite, workOverwrite, symlinkEscape, runtimeWrite, tempWrite, network, sockets,
      fixture: readFileSync('/work/fixture.txt','utf8'), bash: { status: bash.status, stdout: bash.stdout },
      escape: { status: escape.status, stdout: escape.stdout },
      caps: status.match(/^Cap(?:Eff|Prm|Bnd|Amb):.*$/gm), nnp: status.match(/^NoNewPrivs:.*$/m)?.[0],
      pids: readdirSync('/proc').filter(x=>/^\d+$/.test(x)), fds: readdirSync('/proc/self/fd').map(fd=>{try{return [fd,readlinkSync('/proc/self/fd/'+fd)]}catch{return [fd,'closed']}}),
      hostCanaryVisible: existsSync(process.argv[3] ?? '/outside-canary'),
    }));
  }
}
