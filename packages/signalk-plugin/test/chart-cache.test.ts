import { cacheChartInputs } from "../src/tiles/inputs.js";
import { expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import type { WorkerOptions } from "node:worker_threads";
import { createDB } from "../src/storage.js";
import { createPreviewStore } from "../src/tiles/history-preview.js";
import { startChart, startChartSafely } from "../src/chart.js";
import { createTileService } from "../src/tiles/service.js";
import {
  refineHistory,
  refineVisible,
  reweightCells,
  UncertainRefinementCommit,
} from "../src/tiles/refine.js";
import { app, config } from "./helper.js";

vi.mock("node:timers/promises", async (original) => {
  const actual = await original<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});

// Vitest loads chart sources; worker threads execute the corresponding built files.
vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(file: string | URL, options?: WorkerOptions) {
        super(
          file instanceof URL
            ? new URL(file.href.replace("/src/tiles/", "/dist/tiles/"))
            : file,
          options,
        );
      }
    },
  };
});

vi.mock("../src/tiles/service.js", async (original) => {
  const actual = await original<typeof import("../src/tiles/service.js")>();
  return {
    ...actual,
    createTileService: vi.fn(
      (...args: Parameters<typeof actual.createTileService>) => {
        const service = actual.createTileService(...args);
        vi.spyOn(service, "persist");
        vi.spyOn(service, "reset");
        return service;
      },
    ),
  };
});
vi.mock("../src/tiles/history-preview.js", async (original) => {
  const actual =
    await original<typeof import("../src/tiles/history-preview.js")>();
  return { ...actual, createPreviewStore: vi.fn(actual.createPreviewStore) };
});
vi.mock("../src/tiles/inputs.js", async (original) => {
  const actual = await original<typeof import("../src/tiles/inputs.js")>();
  return { ...actual, cacheChartInputs: vi.fn(actual.cacheChartInputs) };
});
vi.mock("../src/tiles/refine.js", async (original) => ({
  ...(await original<typeof import("../src/tiles/refine.js")>()),
  reweightCells: vi.fn(async () => {}),
  refineHistory: vi.fn(async () => {}),
  refineVisible: vi.fn(async () => {}),
}));
const server = () =>
  ({
    ...app,
    getSelfPath: () => undefined,
    subscriptionmanager: { subscribe: () => {} },
    get: () => {},
    use: () => {},
    registerResourceProvider: () => {},
    error: vi.fn(),
  }) as unknown as typeof app;
const source = {
  createWriter: () => undefined as never,
  createReader: () => undefined,
  getAvailableTimeframes: () => [],
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("chart shutdown waits for preview worker termination", async () => {
  const db = createDB(":memory:"),
    controller = new AbortController();
  const chart = startChart({
    app: server(),
    config,
    db,
    signal: controller.signal,
  });
  const preview = vi.mocked(createPreviewStore).mock.results.at(-1)!.value;
  const close = preview.close.bind(preview),
    pending = deferred();
  vi.spyOn(preview, "close").mockImplementation(async () => {
    await close();
    await pending.promise;
    return [];
  });
  try {
    controller.abort();
    let stopped = false;
    const done = chart.close().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(preview.close).toHaveBeenCalledTimes(1);
    pending.resolve();
    await done;
    expect(stopped).toBe(true);
  } finally {
    pending.resolve();
    await chart.close();
    db.close();
  }
});

test("file-backed chart coordinates preview writes and releases its worker locks on close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crowd-depth-chart-workers-"));
  const file = join(dir, "test.sqlite"),
    db = createDB(file);
  const controller = new AbortController();
  const chart = startChart({
    app: server(),
    config,
    db,
    signal: controller.signal,
  });
  const preview = vi.mocked(createPreviewStore).mock.results.at(-1)!.value;
  const tiles = vi.mocked(createTileService).mock.results.at(-1)!.value;
  try {
    const write = preview.writeAsync(
      "history",
      Array.from({ length: 1000 }, (_, i) => ({
        lon: -80 + i / 5400,
        lat: 26,
        depth: 4,
        time: Date.now(),
      })),
    );
    expect(tiles.persist).toHaveBeenLastCalledWith(false);
    await write;
    await expect
      .poll(() => vi.mocked(tiles.persist).mock.calls.at(-1)?.[0])
      .toBe(true);
    expect(
      db.prepare("SELECT count(*) n FROM preview_cells").get()?.n,
    ).toBeGreaterThan(0);
    controller.abort();
    await chart.close();
    const next = new DatabaseSync(file);
    next.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK");
    next.close();
  } finally {
    controller.abort();
    await chart.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overlapping visible and historical refinement keep persistence suspended until both finish", async () => {
  const db = createDB(":memory:"),
    controller = new AbortController(),
    global = deferred(),
    visible = deferred(),
    weighted = deferred();
  let releaseVisible!: () => void;
  let visibleReleased = false;
  vi.mocked(reweightCells).mockReturnValueOnce(weighted.promise);
  vi.mocked(refineHistory).mockReturnValueOnce(global.promise);
  vi.mocked(refineVisible).mockImplementationOnce((options) => {
    options.onBusy!(true);
    releaseVisible = () => {
      if (visibleReleased) return;
      visibleReleased = true;
      options.onBusy!(false);
      visible.resolve();
    };
    return visible.promise;
  });
  const chart = startChart({
    app: server(),
    config,
    db,
    signal: controller.signal,
  });
  const tiles = vi.mocked(createTileService).mock.results.at(-1)!.value;
  const run = chart.backfill(source);
  try {
    await Promise.resolve();
    expect(tiles.persist).toHaveBeenLastCalledWith(false);
    weighted.resolve();
    await vi.waitFor(() => expect(releaseVisible).toBeDefined());
    expect(tiles.persist).toHaveBeenLastCalledWith(false);
    global.resolve();
    await run;
    expect(tiles.persist).toHaveBeenLastCalledWith(false);
    releaseVisible();
    expect(tiles.persist).toHaveBeenLastCalledWith(true);
  } finally {
    controller.abort();
    weighted.resolve();
    global.resolve();
    if (releaseVisible) releaseVisible();
    await run;
    db.close();
  }
});

test.each([false, true])(
  "only an uncertain commit resets caches on refinement failure: %s",
  async (uncertain) => {
    const db = createDB(":memory:"),
      controller = new AbortController(),
      ready = deferred(),
      fake = server();
    const failure = new Error("provider unavailable");
    vi.mocked(refineHistory).mockImplementationOnce(async () => {
      await ready.promise;
      throw uncertain ? new UncertainRefinementCommit(failure) : failure;
    });
    const chart = startChart({
      app: fake,
      config,
      db,
      signal: controller.signal,
    });
    const tiles = vi.mocked(createTileService).mock.results.at(-1)!.value;
    const run = chart.backfill(source);
    try {
      await vi.waitFor(() =>
        expect(tiles.persist).toHaveBeenLastCalledWith(false),
      );
      // Allow startup's synchronous configuration checks to finish.
      await new Promise((r) => setTimeout(r, 10));
      vi.mocked(tiles.reset).mockClear();
      ready.resolve();
      await vi.waitFor(() =>
        expect(fake.error).toHaveBeenCalledWith(
          expect.stringContaining("will retry"),
        ),
      );
      expect(tiles.reset).toHaveBeenCalledTimes(uncertain ? 1 : 0);
      expect(tiles.persist).toHaveBeenLastCalledWith(true);
    } finally {
      controller.abort();
      ready.resolve();
      await run;
      db.close();
    }
  },
);

test("preview migration does not block historical or visible refinement", async () => {
  const db = createDB(":memory:"),
    controller = new AbortController(),
    indexing = deferred();
  const actual = await vi.importActual<
    typeof import("../src/tiles/history-preview.js")
  >("../src/tiles/history-preview.js");
  vi.mocked(createPreviewStore).mockImplementationOnce((...args) => {
    const store = actual.createPreviewStore(...args);
    return { ...store, prepare: () => indexing.promise };
  });
  const history = vi.mocked(refineHistory).mock.calls.length;
  const visible = vi.mocked(refineVisible).mock.calls.length;
  const chart = startChart({
    app: server(),
    config,
    db,
    signal: controller.signal,
  });
  const tiles = vi.mocked(createTileService).mock.results.at(-1)!.value;
  try {
    await chart.backfill(source);
    expect(vi.mocked(refineHistory).mock.calls.length).toBeGreaterThan(history);
    expect(vi.mocked(refineVisible).mock.calls.length).toBeGreaterThan(visible);
    expect(tiles.persist).toHaveBeenLastCalledWith(false);
    indexing.resolve();
    await vi.waitFor(() =>
      expect(tiles.persist).toHaveBeenLastCalledWith(true),
    );
  } finally {
    controller.abort();
    indexing.resolve();
    await Promise.resolve();
    db.close();
  }
});

test("closing a chart cancels refinement even when its parent session is still active", async () => {
  const db = createDB(":memory:");
  const parent = new AbortController();
  let refinementSignal: AbortSignal | undefined;
  vi.mocked(refineVisible).mockImplementationOnce(({ signal }) => {
    refinementSignal = signal;
    return new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const chart = startChart({
    app: server(),
    config,
    db,
    signal: parent.signal,
  });
  try {
    await chart.backfill(source);
    expect(refinementSignal?.aborted).toBe(false);
    await chart.close();
    expect(refinementSignal?.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  } finally {
    parent.abort();
    await chart.close();
    db.close();
  }
});

test.each([true, false])(
  "chart startup isolates preview damage before a configuration rebuild (visible %s)",
  async (show) => {
    const dir = mkdtempSync(join(tmpdir(), "crowd-depth-chart-damage-"));
    const file = join(dir, "test.sqlite");
    let db = createDB(file);
    const preview = createPreviewStore(db, "previous");
    preview.write("history", [
      { lon: -80, lat: 26, depth: 4, time: Date.now() },
    ]);
    await preview.close();
    db.enableDefensive?.(false);
    db.exec("UPDATE preview_spatial_node SET data=x'00' WHERE nodeno=1");
    db.close();
    db = createDB(file);
    const parent = new AbortController();
    let chart: ReturnType<typeof startChart> | undefined;
    try {
      const app = server();
      chart = startChartSafely({
        app,
        config: { ...config, chart: { ...config.chart, show } },
        db,
        signal: parent.signal,
      });
      expect(app.error).not.toHaveBeenCalledWith(
        expect.stringContaining("failed to start"),
      );
      expect(!!chart).toBe(show);
      expect(
        db
          .prepare("SELECT value FROM tile_meta WHERE key='config_position'")
          .get(),
      ).toBeDefined();
    } finally {
      parent.abort();
      await chart?.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("input cache initialization retries and aborts cleanly on chart close", async () => {
  const db = createDB(":memory:"),
    controller = new AbortController(),
    app = server();
  vi.mocked(cacheChartInputs).mockRejectedValueOnce(new Error("cache locked"));
  const chart = startChart({ app, config, db, signal: controller.signal });
  const run = chart.backfill({
    createReader: () => undefined,
    getAvailableTimeframes: () => [],
  });
  try {
    await vi.waitFor(() =>
      expect(app.error).toHaveBeenCalledWith(
        expect.stringContaining("Historical input cache unavailable; retrying"),
      ),
    );
    await chart.close();
    await expect(run).resolves.toBeUndefined();
  } finally {
    controller.abort();
    await chart.close();
    db.close();
  }
});

test("persistent input cache failures back off to five minutes and resume after recovery", async () => {
  const inputs = await vi.importActual<typeof import("../src/tiles/inputs.js")>(
    "../src/tiles/inputs.js",
  );
  const actual = await vi.importActual<typeof import("node:timers/promises")>(
    "node:timers/promises",
  );
  const delays: number[] = [];
  let retryPending = false;
  vi.mocked(sleep).mockImplementation((ms, value, options) => {
    if (retryPending) {
      retryPending = false;
      delays.push(ms!);
      return Promise.resolve(value);
    }
    return actual.setTimeout(ms, value, options);
  });
  for (let i = 0; i < 8; i++)
    vi.mocked(cacheChartInputs).mockImplementationOnce(async () => {
      retryPending = true;
      throw new Error("cache unavailable");
    });
  vi.mocked(cacheChartInputs).mockResolvedValueOnce(source);
  const db = createDB(":memory:");
  const parent = new AbortController();
  const chart = startChart({
    app: server(),
    config,
    db,
    signal: parent.signal,
  });
  try {
    await chart.backfill({
      createReader: () => undefined,
      getAvailableTimeframes: () => [],
    });
    expect(delays).toEqual([
      5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000,
    ]);
  } finally {
    parent.abort();
    await chart.close();
    db.close();
    vi.mocked(sleep).mockImplementation(actual.setTimeout);
    vi.mocked(cacheChartInputs)
      .mockReset()
      .mockImplementation(inputs.cacheChartInputs);
  }
});
