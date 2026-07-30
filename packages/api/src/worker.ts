// Cloudflare Workers entry. Runs the same Express app as the Vercel entry,
// bridged to workerd via cloudflare:node's httpServerHandler.
import { httpServerHandler } from "cloudflare:node";
import { env } from "cloudflare:workers";
import { createApp } from "./app.js";
import { R2Storage, type R2BucketLike } from "./r2.js";
import { sweep } from "./sweep.js";

const storage = new R2Storage(env.BUCKET as R2BucketLike);
const app = createApp({ storage });

app.listen(8080);

const handler = httpServerHandler({ port: 8080 });

export default {
  fetch: (request: unknown, env: unknown, ctx: unknown) =>
    handler.fetch(request, env, ctx),
  // Hourly cron: deliver stored submissions that haven't reached NOAA
  scheduled: () => sweep({ storage }),
};
