export function resolveRequestedAddon(argv: string[], configuredAddon?: string): string | undefined {
  return configuredAddon || argv.slice(2).find((arg) => !arg.startsWith('-'));
}
