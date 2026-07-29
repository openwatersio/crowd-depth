// Cloudflare Workers entry. Runs the same Express app as the Vercel entry,
// bridged to workerd via cloudflare:node's httpServerHandler.
import { httpServerHandler } from "cloudflare:node";
import app from "./app.js";

app.listen(8080);

export default httpServerHandler({ port: 8080 });
