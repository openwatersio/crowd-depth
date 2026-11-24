// Keep renderer startup to one module read, particularly on Pi SD cards.
// tsc still emits the other modules for the plugin and development watch mode.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["src/tiles/tile-worker.ts"],
  outfile: "dist/tiles/tile-worker.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  logLevel: "info",
});
