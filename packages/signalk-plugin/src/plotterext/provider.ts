// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
import { existsSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerAPI } from "@signalk/server-api";
import { ASSET_BASE, PLUGIN_ID, buildManifest } from "./manifest.js";

/** The server API the plugin receives also carries Express's `use` and the
 * resource-provider registry, which the typed interface does not declare. */
interface ExtensionApp extends ServerAPI {
  use?: (
    path: string,
    handler: (req: { path: string }, res: AssetResponse, next: Next) => void,
  ) => void;
}

let mounted = false;

/** Offer the plotter extension: register the read-only `plotterExtensions`
 * resource and mount the extension's pages. Called on every start: the server
 * drops a plugin's resource providers when it stops, and registering again
 * replaces the entry. The pages are mounted once, since Express routes persist.
 * `isRunning` reflects the plugin's current state. */
export function registerPlotterExtension(
  app: ServerAPI,
  isRunning: () => boolean,
): void {
  const a = app as ExtensionApp;

  if (typeof a.registerResourceProvider === "function") {
    a.registerResourceProvider({
      type: "plotterExtensions",
      methods: {
        listResources: async () =>
          isRunning() ? { [PLUGIN_ID]: buildManifest() } : {},
        getResource: async (id: string) => {
          if (!isRunning() || id !== PLUGIN_ID) {
            throw new Error(`No such plotterExtensions resource: ${id}`);
          }
          return buildManifest();
        },
        setResource: async () => {
          throw new Error(`${PLUGIN_ID} is a read-only provider`);
        },
        deleteResource: async () => {
          throw new Error(`${PLUGIN_ID} is a read-only provider`);
        },
      },
    });
    a.debug(`${PLUGIN_ID}: plotter extension offered`);
  } else {
    a.debug(`${PLUGIN_ID}: server has no resource provider registry`);
  }

  mountAssets(a);
}

/** Content types for the files `scripts/build-web.mjs` writes. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

type Next = () => void;
interface AssetResponse {
  type(value: string): AssetResponse;
  sendFile(path: string): void;
}

/** Where `scripts/build-web.mjs` writes the built pages. Worked out when the
 * pages are mounted, not when the module loads: the API's Worker bundles this
 * package, and `import.meta.url` isn't a file URL there, so resolving it at
 * load time crashes the Worker on startup. */
function publicDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
}

/** Serve files from `root` by path, without Express's static middleware: the
 * plugin can't count on resolving `express` itself, since the server, which
 * owns it, is often installed elsewhere. Anything that isn't one of the built
 * pages falls through to the routes after it. */
export function createAssetHandler(root: string) {
  return (req: { path: string }, res: AssetResponse, next: Next) => {
    const file = resolve(
      root,
      `.${req.path === "/" ? "/index.html" : req.path}`,
    );
    const type = CONTENT_TYPES[extname(file)];
    if (!type || !file.startsWith(root + sep) || !existsSync(file)) {
      return next();
    }
    res.type(type).sendFile(file);
  };
}

/** Serve the extension's pages as a top-level route, once. */
function mountAssets(app: ExtensionApp): void {
  if (mounted || typeof app.use !== "function") {
    return;
  }
  app.use(ASSET_BASE, createAssetHandler(publicDir()));
  mounted = true;
  app.debug(`${PLUGIN_ID}: extension assets served at ${ASSET_BASE}`);
}
