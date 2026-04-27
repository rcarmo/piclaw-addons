declare module "@mariozechner/pi-coding-agent" {
  export interface ExtensionAPI {
    on(event: string, handler: (...args: any[]) => any): void;
    registerTool(tool: any): void;
    exec(command: string, args: string[], options?: { timeout?: number }): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  }
}

declare module "@sinclair/typebox" {
  export const Type: {
    Object(definition: Record<string, unknown>): unknown;
    String(options?: Record<string, unknown>): unknown;
    Number(options?: Record<string, unknown>): unknown;
    Optional(schema: unknown): unknown;
  };
}
