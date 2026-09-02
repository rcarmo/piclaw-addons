export function addonFromFile(file = '', configuredAddon = process.env.PICLAW_ADDON): string {
  const normalized = file.replaceAll('\\', '/');
  const generatedMatch = normalized.match(/\.generated\/([^/]+)\//);
  const relativeMatch = normalized.match(/^(?!\.\.\/)([^/]+)\/[^/]+\.spec\.[cm]?[jt]s$/);
  return generatedMatch?.[1] || relativeMatch?.[1] || configuredAddon || 'addon';
}
