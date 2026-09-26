import { resticRuntime } from './runtime-state.ts';

const string = { type: 'string' };
const count = { type: 'integer', minimum: 0, maximum: 10000 };
const configSchema = {
  type: 'object',
  description: 'Complete configuration returned by get_config with your changes. Store keychain reference names only, never secret values. Repository-specific fields are validated by the same backend as Settings.',
  required: ['enabled', 'repository', 'passwordRef', 'retention', 'binary', 'excludes', 'schedule'],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    repository: { type: ['object', 'null'], additionalProperties: false, properties: {
      backend: { type: 'string', enum: ['local', 'sftp', 's3', 'azure'] },
      path: string, expectedMount: string, host: string, port: { type: 'integer', minimum: 1, maximum: 65535 }, user: string,
      privateKeyRef: string, knownHostsRef: string, endpoint: string, region: string, bucket: string, prefix: string,
      accessKeyRef: string, secretKeyRef: string, sessionTokenRef: string, account: string, container: string, accountKeyRef: string,
    } },
    passwordRef: { ...string, description: 'Keychain reference for the repository encryption password; separate from transport credentials.' },
    retention: { type: 'object', additionalProperties: false, required: ['enabled', 'hourly', 'daily', 'weekly', 'monthly'], properties: {
      enabled: { type: 'boolean' }, hourly: count, daily: count, weekly: count, monthly: count,
    } },
    binary: { ...string, description: 'managed (default), restic from PATH, or an absolute executable path. Setting this never installs or executes it.' },
    excludes: { type: 'array', items: string, maxItems: 200 },
    schedule: { type: 'object', additionalProperties: false, required: ['enabled', 'hours', 'minute', 'timezone'], properties: {
      enabled: { type: 'boolean' }, hours: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 23 }, minItems: 1 },
      minute: { type: 'integer', minimum: 0, maximum: 59 }, timezone: string,
    } },
  },
};

/** Use the startup-owned service; registering a tool must not spawn a second scheduler. */
export default function resticAddon(pi: any) {
  pi.registerTool({
    name: 'restic',
    label: 'Restic configuration',
    description: 'Read or configure this instance’s Restic backup add-on. Use get_config, edit the returned full config, then set_config. Keychain reference names only; use the keychain tool separately for secrets. Shares Settings validation, locks, prior-backup and legacy-scheduler checks. Enabling a schedule permits future automatic backups; retention remains explicit-preview only. No immediate backup, restore, prune, binary install, credential retrieval or external scheduler management is exposed here.',
    parameters: {
      type: 'object', required: ['action'], additionalProperties: false,
      properties: { action: { type: 'string', enum: ['get_config', 'set_config', 'status'] }, config: configSchema },
    },
    async execute(_id: string, params: any, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (!params || typeof params !== 'object' || Array.isArray(params)
        || Object.keys(params).some(key => !['action', 'config'].includes(key))
        || !['get_config', 'set_config', 'status'].includes(params.action)) throw Error('Invalid Restic configuration action');
      if (params.action !== 'set_config' && params.config !== undefined) throw Error('Only set_config accepts configuration');
      const service = resticRuntime().service;
      if (!service) throw Error('Restic startup runtime is unavailable; enable the add-on and reload the host');
      let details: unknown;
      if (params.action === 'set_config') details = { config: await service.setConfig(params.config) };
      else {
        const snapshot = service.configurationSnapshot();
        details = params.action === 'get_config' ? { config: snapshot.config } : { state: snapshot.state };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
    },
  });
}
