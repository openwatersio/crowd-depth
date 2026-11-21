import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerAPI } from "@signalk/server-api";
import createPlugin from "../src/plugin.js";
import { createReporter } from "../src/reporters/index.js";
import { settleSource } from "../src/sources/settle.js";
import { app as baseApp, config } from "./helper.js";

vi.mock("../src/sources/settle.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/sources/settle.js")>();
  return { ...original, settleSource: vi.fn(original.settleSource) };
});

vi.mock("../src/reporters/index.js", async (original) => ({
  ...(await original<typeof import("../src/reporters/index.js")>()),
  createReporter: vi.fn(),
}));

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

  test.each([false, true])(
    "stop finishes even if the final upload fails: %s",
    async (fails) => {
      let release!: () => void;
      const flush = vi.fn(async () => {
        expect(
          vi.mocked(settleSource).mock.calls.at(-1)![0].signal.aborted,
        ).toBe(true);
        expect(
          vi.mocked(createReporter).mock.calls.at(-1)![0].signal.aborted,
        ).toBe(false);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (fails) throw new Error("offline");
      });
      vi.mocked(createReporter).mockReturnValueOnce({
        flush,
        report: vi.fn(),
        reportInBatches: vi.fn(),
      });
      vi.mocked(settleSource).mockResolvedValueOnce({
        createReader: () => undefined,
        getAvailableTimeframes: () => [],
      });
      const plugin = createPlugin(app);
      plugin.start(config, () => {});
      await vi.waitFor(() =>
        expect(
          vi.mocked(createReporter).mock.results.at(-1)?.value?.flush,
        ).toBe(flush),
      );
      let stopped = false;
      const stopping = Promise.resolve(plugin.stop()).then(() => {
        stopped = true;
      });
      expect(stopped).toBe(false);
      expect(flush).toHaveBeenCalledTimes(1);
      release();
      await stopping;
      expect(
        vi.mocked(createReporter).mock.calls.at(-1)![0].signal.aborted,
      ).toBe(true);
      if (fails)
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining("unreported data remains queued"),
        );
    },
  );

  test.each([
    { enabled: false },
    { enabled: true, configuration: { sharing: { anonymous: true } } },
  ])(
    "does not flush when sharing is disabled or made anonymous: %j",
    async (saved) => {
      const flush = vi.fn();
      vi.mocked(createReporter).mockReturnValueOnce({
        flush,
        report: vi.fn(),
        reportInBatches: vi.fn(),
      });
      vi.mocked(settleSource).mockResolvedValueOnce({
        createReader: () => undefined,
        getAvailableTimeframes: () => [],
      });
      app.readPluginOptions = () =>
        saved as ReturnType<ServerAPI["readPluginOptions"]>;
      const plugin = createPlugin(app);
      plugin.start(config, () => {});
      await vi.waitFor(() =>
        expect(
          vi.mocked(createReporter).mock.results.at(-1)?.value?.flush,
        ).toBe(flush),
      );
      await plugin.stop();
      expect(flush).not.toHaveBeenCalled();
      expect(
        vi.mocked(createReporter).mock.calls.at(-1)![0].signal.aborted,
      ).toBe(true);
    },
  );

  test("an already anonymous configuration still gets a final flush", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createReporter).mockReturnValueOnce({
      flush,
      report: vi.fn(),
      reportInBatches: vi.fn(),
    });
    vi.mocked(settleSource).mockResolvedValueOnce({
      createReader: () => undefined,
      getAvailableTimeframes: () => [],
    });
    const anonymous = { ...config, sharing: { anonymous: true } };
    app.readPluginOptions = () => ({ enabled: true, configuration: anonymous });
    const plugin = createPlugin(app);
    plugin.start(anonymous, () => {});
    await vi.waitFor(() =>
      expect(vi.mocked(createReporter).mock.results.at(-1)?.value?.flush).toBe(
        flush,
      ),
    );
    await plugin.stop();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  test.each(["disable", "anonymous", "reason"])(
    "a second stop cancels an active flush when sharing changes: %s",
    async (action) => {
      let reportSignal!: AbortSignal;
      const flush = vi.fn(
        () =>
          new Promise<void>((resolve) =>
            reportSignal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          ),
      );
      vi.mocked(createReporter).mockImplementationOnce((options) => {
        reportSignal = options.signal;
        return { flush, report: vi.fn(), reportInBatches: vi.fn() };
      });
      vi.mocked(settleSource).mockResolvedValueOnce({
        createReader: () => undefined,
        getAvailableTimeframes: () => [],
      });
      const plugin = createPlugin(app);
      plugin.start(config, () => {});
      await vi.waitFor(() => expect(reportSignal).toBeDefined());
      const first = plugin.stop({ reason: "restart" });
      expect(reportSignal.aborted).toBe(false);
      if (action !== "reason")
        app.readPluginOptions = () => ({
          enabled: action !== "disable",
          configuration: {
            ...config,
            sharing: { anonymous: action === "anonymous" },
          },
        });
      const second = plugin.stop({
        reason: action === "reason" ? "disable" : "restart",
      });
      expect(reportSignal.aborted).toBe(true);
      expect(second).toBe(first);
      await second;
      expect(flush).toHaveBeenCalledTimes(1);
    },
  );

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
