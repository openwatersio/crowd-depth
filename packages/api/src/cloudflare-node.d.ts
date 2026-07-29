// Minimal ambient types for the workerd-only module so worker.ts type-checks
// under tsc; wrangler resolves the real module at build time.
declare module "cloudflare:node" {
  export function httpServerHandler(options: { port: number }): {
    fetch: (request: unknown, env: unknown, ctx: unknown) => Promise<unknown>;
  };
}
