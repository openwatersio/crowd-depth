import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerAPI } from "@signalk/server-api";
import createPlugin from "../src/plugin.js";
import { settleSource } from "../src/sources/settle.js";
import { app as baseApp, config } from "./helper.js";

vi.mock("../src/sources/settle.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/sources/settle.js")>();
  return { ...original, settleSource: vi.fn(original.settleSource) };
});

describe("plugin", () => {
  let dataDir: string;
  let app: ServerAPI;
  let error: ReturnType<typeof vi.fn>;
  let setPluginError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "crowd-depth-plugin-"));
    error = vi.fn();
    setPluginError = vi.fn();
    // No history provider, built in or over HTTP, so the source waits the full
    // BATHY_HISTORY_WAIT for one to appear.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    // Any server method the test doesn't name is a no-op, as on a server that
    // lacks it.
    app = new Proxy(
      {
        ...baseApp,
        error,
        setPluginError,
        getDataDirPath: () => dataDir,
        getHistoryApi: () => Promise.reject(new Error("no provider")),
      } as Record<string, unknown>,
      {
        get: (target, prop) =>
          prop in target ? target[prop as string] : () => {},
      },
    ) as unknown as ServerAPI;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // The plugin keeps its database open after stop(), and Windows refuses to
    // delete an open file, so the directory may outlive the test there.
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Left in the OS temp directory.
    }
  });

  test("start() returns without waiting for a history provider", () => {
    const plugin = createPlugin(app);
    expect(plugin.start(config, () => {})).toBeUndefined();
    plugin.stop();
  });

  test("reports an error from choosing the source", async () => {
    vi.mocked(settleSource).mockRejectedValueOnce(new Error("boom"));
    const plugin = createPlugin(app);
    plugin.start(config, () => {});
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ message: "boom" }),
      ),
    );
    expect(setPluginError).toHaveBeenLastCalledWith(
      expect.stringContaining("boom"),
    );
    plugin.stop();
  });

  test("stays quiet about an error that arrives after stop()", async () => {
    let reject!: (err: Error) => void;
    vi.mocked(settleSource).mockReturnValueOnce(
      new Promise((_, r) => (reject = r)),
    );
    const plugin = createPlugin(app);
    plugin.start(config, () => {});
    plugin.stop();
    reject(new Error("boom"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(error).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
    );
  });
});
