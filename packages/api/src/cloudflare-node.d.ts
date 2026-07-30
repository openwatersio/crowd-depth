// Minimal ambient types for the workerd-only modules so worker.ts type-checks
// under tsc; wrangler resolves the real modules at build time.
declare module "cloudflare:node" {
  export function httpServerHandler(options: { port: number }): {
    fetch: (request: unknown, env: unknown, ctx: unknown) => Promise<unknown>;
  };
}

declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
