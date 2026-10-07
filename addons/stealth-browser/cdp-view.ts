import { createServer } from 'node:net';
export async function reserveViewerPort(): Promise<{ port: number; release(): Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  return { port, release: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
export function registerStealthViewer(port: number): () => void {
  const register = (globalThis as any).__piclaw_registerCdpViewSource;
  return typeof register === 'function' ? register({ id: 'stealth', label: 'Stealth Browser', port, restoreViewport: 'clear' }) : () => {};
}
export function assertStealthToolControl(): void {
  (globalThis as any).__piclaw_assertCdpViewToolControl?.('stealth');
}
export function beginStealthToolControl(): (() => void) | undefined {
  return (globalThis as any).__piclaw_beginCdpViewTool?.('stealth');
}
