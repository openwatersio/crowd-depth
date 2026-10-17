// Build the extension's browser assets into public/, which the plugin serves
// as a top-level static route at /plotterext/crowd-depth/.
//
// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
//
// The pages are the extension's background runtime (renderer), its settings
// panel, and the render Worker. They are TypeScript, bundled here so the
// browser never sees a module graph. The plugin's Node code (dist/) is built
// separately by tsc.

import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");
const pub = join(root, "public");

rmSync(pub, { recursive: true, force: true });
mkdirSync(join(pub, "js"), { recursive: true });

// One bundle per page, plus the render Worker as its own entry (a Worker is a
// separate script, not part of the page bundle).
await build({
  entryPoints: [
    join(web, "renderer.ts"),
    join(web, "config.ts"),
    join(web, "render-worker.ts"),
  ],
  bundle: true,
  format: "esm",
  outdir: join(pub, "js"),
  sourcemap: false,
  target: ["es2022"],
  logLevel: "info",
});

cpSync(join(web, "styles.css"), join(pub, "styles.css"));

const page = (name, title, extraHead = "") => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="styles.css">
${extraHead}
</head>
<body class="${name}">
<div id="root"></div>
<script type="module" src="js/${name}.js"></script>
</body>
</html>
`;

writeFileSync(
  join(pub, "renderer.html"),
  page("renderer", "My soundings renderer"),
);
writeFileSync(
  join(pub, "config.html"),
  page("config", "My soundings settings"),
);
writeFileSync(
  join(pub, "index.html"),
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>My soundings</title>
<link rel="stylesheet" href="styles.css"></head>
<body class="config">
<div id="root">
<h2>My soundings</h2>
<p class="status">Crowd Depth draws the depths this boat records as a layer on
chartplotters that support the Signal K <code>plotterExtensions</code> resource
type, such as Freeboard-SK. Open your chartplotter; the layer appears in its
layer controls, and its settings are behind the My soundings toolbar button.</p>
</div>
</body>
</html>
`,
);

console.error("public/ extension assets written");
