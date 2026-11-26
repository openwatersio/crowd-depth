import { collectObservations } from "../src/observations/collect.js";
import { createCollector } from "../src/collector.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerAPI } from "@signalk/server-api";
import createPlugin from "../src/plugin.js";
import { createReporter } from "../src/reporters/index.js";
import { settleSource } from "../src/sources/settle.js";
import { app as baseApp, config } from "./helper.js";
import { startChartSafely } from "../src/chart.js";

vi.mock("../src/observations/collect.js", () => ({
  collectObservations: vi.fn(
    async (...args: Parameters<typeof collectObservations>) => {
      const built = await import("../dist/observations/collect.js");
      return built.collectObservations(...args);
    },
  ),
}));

vi.mock("../src/collector.js", async (original) => {
  const actual = await original<typeof import("../src/collector.js")>();
  return { ...actual, createCollector: vi.fn(actual.createCollector) };
});

vi.mock("../src/chart.js", async (original) => {
  const actual = await original<typeof import("../src/chart.js")>();
  return { ...actual, startChartSafely: vi.fn(actual.startChartSafely) };
});

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

  test("observation recording retries visibly and resets backoff after a commit", async () => {
    vi.mocked(startChartSafely).mockReturnValueOnce({
      close: async () => {},
      backfill: async () => {},
    });
    vi.mocked(settleSource).mockResolvedValueOnce(undefined);
    const collect = vi.mocked(collectObservations);
    const before = collect.mock.calls.length;
    collect
      .mockRejectedValueOnce(new Error("fixture storage failure"))
      .mockImplementationOnce(async (...args) => {
        args[4]?.();
        throw new Error("second failure");
      })
      .mockImplementationOnce(
        async (...args) =>
          new Promise<void>((resolve) => {
            args[3].addEventListener("abort", () => resolve(), { once: true });
          }),
      );
    const plugin = createPlugin(app);
    try {
      plugin.start(config, () => {});
      await vi.waitFor(() => expect(setPluginError).toHaveBeenCalled());
      expect(setPluginError).toHaveBeenCalledWith(
        expect.stringContaining("fixture storage failure"),
      );
      await vi.waitFor(
        () => expect(collect.mock.calls.length - before).toBe(2),
        { timeout: 6500 },
      );
      await vi.waitFor(
        () => expect(collect.mock.calls.length - before).toBe(3),
        { timeout: 6500 },
      );
    } finally {
      await plugin.stop();
    }
  }, 15000);

  test("an old observation drain cannot overwrite status after stop", async () => {
    vi.mocked(startChartSafely).mockReturnValueOnce({
      close: async () => {},
      backfill: async () => {},
    });
    vi.mocked(settleSource).mockResolvedValueOnce(undefined);
    const setPluginStatus = vi.fn();
    app.setPluginStatus = setPluginStatus;
    let listening = false;
    vi.mocked(collectObservations).mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        args[3].addEventListener("abort", () => resolve(), { once: true });
        listening = true;
      });
      args[4]?.();
      throw Error("drain failed");
    });
    const plugin = createPlugin(app);
    try {
      plugin.start(config, () => {});
      await vi.waitFor(() => expect(listening).toBe(true));
      const normal = setPluginStatus.mock.calls.length,
        failures = setPluginError.mock.calls.length;
      await plugin.stop();
      expect(setPluginStatus.mock.calls.length).toBe(normal);
      expect(setPluginError.mock.calls.length).toBe(failures);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Observation drain failed during stop"),
      );
    } finally {
      await plugin.stop();
    }
  });

  test("start() returns without waiting for a history provider", () => {
    const plugin = createPlugin(app);
    expect(plugin.start(config, () => {})).toBeUndefined();
    plugin.stop();
  });

  test("rapid replacements wait for the oldest chart's workers", async () => {
    let release!: () => void;
    const closing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = { close: vi.fn(() => closing), backfill: async () => {} };
    const last = { close: vi.fn(async () => {}), backfill: async () => {} };
    const starts = vi.mocked(startChartSafely);
    const before = starts.mock.calls.length;
    const recording = vi.mocked(createCollector).mock.calls.length;
    starts.mockReturnValueOnce(first).mockReturnValueOnce(last);
    const plugin = createPlugin(app);
    try {
      plugin.start(config, () => {});
      plugin.start(config, () => {});
      plugin.start(config, () => {});
      await new Promise((resolve) => setImmediate(resolve));
      expect(starts.mock.calls.length - before).toBe(1);
      await vi.waitFor(() =>
        expect(vi.mocked(createCollector).mock.calls.length).toBeGreaterThan(
          recording,
        ),
      );
      release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(starts.mock.calls.length - before).toBe(2);
      await plugin.stop();
      expect(last.close).toHaveBeenCalled();
    } finally {
      release();
      await plugin.stop();
    }
  });

  test("a rejected chart backfill is logged without stopping reporting", async () => {
    vi.mocked(startChartSafely).mockReturnValueOnce({
      close: async () => {},
      backfill: async () => {
        throw new Error("cache initialization failed");
      },
    });
    vi.mocked(settleSource).mockResolvedValueOnce({
      createReader: () => undefined,
      getAvailableTimeframes: () => [],
    });
    const plugin = createPlugin(app);
    const before = vi.mocked(createReporter).mock.calls.length;
    try {
      plugin.start(config, () => {});
      await vi.waitFor(() =>
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining("cache initialization failed"),
        ),
      );
      expect(vi.mocked(createReporter).mock.calls.length).toBe(before + 1);
    } finally {
      await plugin.stop();
    }
  });

  test.each([true, false])(
    "saved offsets cannot bypass replace-mode validation (saved path=%s)",
    async (savedPath) => {
      Object.assign(app, {
        config: { settings: { gnssCorrection: "replace" } },
      });
      app.getSelfPath = ((path: string) =>
        path === "environment.depth.belowTransducer"
          ? { $source: "depth.one" }
          : undefined) as typeof app.getSelfPath;
      const charts = vi.mocked(startChartSafely).mock.calls.length;
      const captures = vi.mocked(collectObservations).mock.calls.length;
      const plugin = createPlugin(app);
      try {
        plugin.start(
          { ...config, path: savedPath ? config.path : undefined },
          () => {},
        );
        await vi.waitFor(() =>
          expect(setPluginError).toHaveBeenCalledWith(
            expect.stringContaining("replace mode"),
          ),
        );
        expect(vi.mocked(startChartSafely).mock.calls.length).toBe(charts);
        expect(vi.mocked(collectObservations).mock.calls.length).toBe(captures);
      } finally {
        await plugin.stop();
      }
    },
  );

  test("settings from the progressive preview resolve a missing depth path", async () => {
    app.getSelfPath = ((path: string) =>
      path === "environment.depth.belowTransducer"
        ? { $source: "depth.one" }
        : undefined) as typeof app.getSelfPath;
    vi.mocked(settleSource).mockResolvedValueOnce({
      createReader: () => undefined,
      getAvailableTimeframes: () => [],
    });
    const before = vi.mocked(createReporter).mock.calls.length;
    const plugin = createPlugin(app);
    plugin.start({ ...config, path: undefined }, () => {});
    try {
      await vi.waitFor(() =>
        expect(vi.mocked(createReporter).mock.calls.length).toBeGreaterThan(
          before,
        ),
      );
      expect(
        vi.mocked(createReporter).mock.calls.at(-1)![0].config,
      ).toMatchObject({
        path: "belowTransducer",
        sounder: config.sounder,
      });
    } finally {
      await plugin.stop();
    }
  });

  test.each(["gps.ccrp", ""])(
    "a corrected source (%s) uses the vessel origin rather than correcting twice",
    async (source) => {
      Object.assign(app, {
        config: {
          settings: {
            gnssCorrection: "both",
            gnssSensors: [
              {
                sensorId: "gps",
                $source: "gps.raw",
                fromBow: 5,
                fromCenter: 2,
              },
            ],
          },
        },
      });
      app.getSelfPath = ((path: string) =>
        path === "design.length.value"
          ? { overall: 20 }
          : path === "navigation.position"
            ? { $source: "gps.ccrp" }
            : undefined) as typeof app.getSelfPath;
      vi.mocked(settleSource).mockResolvedValueOnce({
        createReader: () => undefined,
        getAvailableTimeframes: () => [],
      });
      const before = vi.mocked(createReporter).mock.calls.length;
      const plugin = createPlugin(app);
      plugin.start({ ...config, gnss: { ...config.gnss, source } }, () => {});
      try {
        await vi.waitFor(() =>
          expect(vi.mocked(createReporter).mock.calls.length).toBeGreaterThan(
            before,
          ),
        );
        expect(
          vi.mocked(createReporter).mock.calls.at(-1)![0].config,
        ).toMatchObject({
          positionOrigin: { x: 0, y: 10 },
          gnss: { x: 2, y: 5, source: "gps.ccrp" },
        });
      } finally {
        await plugin.stop();
      }
    },
  );

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
