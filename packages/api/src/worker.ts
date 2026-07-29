// Cloudflare Workers entry. Runs the same Express app as the Vercel entry,
// bridged to workerd via cloudflare:node's httpServerHandler.
import { httpServerHandler } from "cloudflare:node";
import { env } from "cloudflare:workers";
import { createApp } from "./app.js";
import { R2Storage, type R2BucketLike } from "./r2.js";

const app = createApp({
  storage: new R2Storage(env.BUCKET as R2BucketLike),
});

app.listen(8080);

export default httpServerHandler({ port: 8080 });
