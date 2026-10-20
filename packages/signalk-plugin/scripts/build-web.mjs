// Build the extension's browser assets into public/, which the plugin serves
// as a top-level static route at /plotterext/crowd-depth/.
//
// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
//
// The one page is the extension's background runtime, which keeps the data overlay
// current. It's TypeScript, bundled here so the browser never sees a module graph. The
// plugin's Node code (dist/) is built separately by tsc.

import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");
const pub = join(root, "public");

rmSync(pub, { recursive: true, force: true });
mkdirSync(join(pub, "js"), { recursive: true });

await build({
  entryPoints: [join(web, "runtime.ts")],
  bundle: true,
  format: "esm",
  outdir: join(pub, "js"),
  sourcemap: false,
  target: ["es2022"],
  logLevel: "info",
});

writeFileSync(
  join(pub, "runtime.html"),
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>My soundings runtime</title></head>
<body><script type="module" src="js/runtime.js"></script></body>
</html>
`,
);
writeFileSync(
  join(pub, "index.html"),
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>My soundings</title></head>
<body>
<h2>My soundings</h2>
<p>Crowd Depth draws the depths this boat records as a layer on
chartplotters that support Signal K plotter extensions with data overlays, such as
Freeboard-SK 3.4. Open your chartplotter; the layer appears in its layer controls.</p>
</body>
</html>
`,
);

console.error("public/ extension assets written");
