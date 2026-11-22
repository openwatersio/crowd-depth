import { expect, test, vi } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { resolveDepthConfig, recordedPath } from "../src/depth-path.js";
import { selectDepthPath, type Config } from "../src/config.js";
import { config } from "./helper.js";

function app(paths: Record<string, unknown> = {}, history?: object) {
  return {
    getSelfPath: (path: string) => paths[path],
    getPath: () => ({}),
    debug: vi.fn(),
    setPluginStatus: vi.fn(),
    getHistoryApi: async () => history,
  } as unknown as ServerAPI;
}
const noPath = { ...config, path: undefined } as unknown as Config;

test("chooses only paths offered by the selected device, in preference order", () => {
  const server = app({
    "environment.depth.belowTransducer": { $source: "bus.1", value: 3 },
    "environment.depth.belowSurface": { $source: "bus.2", value: 3 },
    "environment.depth.belowKeel": { $source: "bus.2", value: 3 },
  });
  expect(selectDepthPath(server)).toBe("belowTransducer");
  expect(selectDepthPath(server, "bus.2")).toBe("belowSurface");
  expect(selectDepthPath(server, "bus.missing")).toBeUndefined();
});

test("preserves a legacy path and its reference even when other live paths exist", async () => {
  const cfg = { ...config, path: "belowKeel" as const };
  expect(
    await resolveDepthConfig(app(), cfg, new AbortController().signal),
  ).toEqual(cfg);
  const server = app({
    "environment.depth.belowTransducer": { $source: "bus.1", value: 3 },
  });
  expect(
    (await resolveDepthConfig(server, cfg, new AbortController().signal))?.path,
  ).toBe("belowKeel");
  expect(cfg.path).toBe("belowKeel");
});

test("discovers a recorded path without live soundings", async () => {
  const history = {
    getPaths: async () => ["environment.depth.belowSurface"],
    getValues: async () => ({
      values: [{ path: "environment.depth.belowSurface" }],
      data: [["2026-01-01T00:00:00Z", 3]],
    }),
  };
  const result = await resolveDepthConfig(
    app({}, history),
    noPath,
    new AbortController().signal,
  );
  expect(result?.path).toBe("belowSurface");
});

test("an explicit history selection must have data from the chosen source", async () => {
  const history = {
    getPaths: async () => [
      "environment.depth.belowSurface",
      "environment.depth.belowTransducer",
    ],
    getValues: vi.fn(async ({ pathSpecs }) => ({
      values: [
        {
          path: pathSpecs[0].path,
          $source: pathSpecs[0].path.endsWith("belowSurface")
            ? "chosen"
            : "other",
        },
      ],
      data: [["2026-01-01T00:00:00Z", 3]],
    })),
  };
  const result = await resolveDepthConfig(
    app({}, history),
    { ...noPath, sounder: { ...config.sounder, source: "chosen" } },
    new AbortController().signal,
  );
  expect(result?.path).toBe("belowSurface");
  expect(history.getValues.mock.calls[0][0].pathSpecs[0].sourceRef).toBe(
    "chosen",
  );
});

test("a stalled history provider neither blocks live detection nor overlaps queries", async () => {
  const paths: Record<string, unknown> = {};
  const getPaths = vi.fn(() => new Promise(() => {}));
  const server = app(paths, { getPaths });
  const controller = new AbortController();
  const resolving = resolveDepthConfig(server, noPath, controller.signal);
  await vi.waitFor(() => expect(getPaths).toHaveBeenCalledTimes(1));
  paths["environment.depth.belowKeel"] = { $source: "depth", value: 3 };
  expect((await resolving)?.path).toBe("belowKeel");
  controller.abort();
});

test("stopping before a sensor appears cancels path discovery", async () => {
  const controller = new AbortController();
  const result = resolveDepthConfig(
    app({}, { getPaths: async () => [] }),
    noPath,
    controller.signal,
  );
  controller.abort();
  expect(await result).toBeUndefined();
});

test("remembered paths resume offline SQLite reports and redetect on source changes", async () => {
  const { createDB } = await import("../src/storage.js");
  const db = createDB(":memory:");
  const paths = {
    "environment.depth.belowSurface": { $source: "one", value: 3 },
  };
  const cfg = { ...noPath, sounder: { ...config.sounder, source: "one" } };
  expect(
    (
      await resolveDepthConfig(
        app(paths),
        cfg,
        new AbortController().signal,
        db,
      )
    )?.path,
  ).toBe("belowSurface");
  expect(
    (await resolveDepthConfig(app(), cfg, new AbortController().signal, db))
      ?.path,
  ).toBe("belowSurface");
  const changed = { ...cfg, sounder: { ...cfg.sounder, source: "two" } };
  expect(
    (
      await resolveDepthConfig(
        app({
          "environment.depth.belowTransducer": { $source: "two", value: 3 },
        }),
        changed,
        new AbortController().signal,
        db,
      )
    )?.path,
  ).toBe("belowTransducer");
  db.close();
});

test("null and stale candidates do not hide a working path", () => {
  const paths = {
    "environment.depth.belowTransducer": { $source: "one", value: null },
    "environment.depth.belowSurface": { $source: "one", value: 3 },
  };
  expect(selectDepthPath(app(paths), "one")).toBe("belowSurface");
  paths["environment.depth.belowTransducer"] = {
    $source: "one",
    value: 4,
    timestamp: "2000-01-01T00:00:00Z",
  } as never;
  expect(selectDepthPath(app(paths), "one")).toBe("belowSurface");
});

test("successful slow history discovery is accepted without blocking live polling", async () => {
  const result = resolveDepthConfig(
    app(
      {},
      {
        getPaths: async () => {
          await new Promise((resolve) => setTimeout(resolve, 2100));
          return ["environment.depth.belowSurface"];
        },
        getValues: async () => ({
          values: [{ path: "environment.depth.belowSurface" }],
          data: [["2026-01-01T00:00:00Z", 3]],
        }),
      },
    ),
    noPath,
    new AbortController().signal,
  );
  expect((await result)?.path).toBe("belowSurface");
});

test("rolling forward respects a Path changed by an older release", async () => {
  const { createDB } = await import("../src/storage.js");
  const db = createDB(":memory:");
  const first = { ...config, path: "belowTransducer" as const };
  await resolveDepthConfig(app(), first, new AbortController().signal, db);
  const rollback = { ...config, path: "belowSurface" as const };
  expect(
    (
      await resolveDepthConfig(
        app(),
        rollback,
        new AbortController().signal,
        db,
      )
    )?.path,
  ).toBe("belowSurface");
  expect(
    (
      await resolveDepthConfig(
        app(),
        rollback,
        new AbortController().signal,
        db,
      )
    )?.path,
  ).toBe("belowSurface");
  db.close();
});

test("initial live paths settle before the preferred available path is remembered", async () => {
  const paths: Record<string, unknown> = {
    "environment.depth.belowSurface": { $source: "one", value: 3 },
  };
  const resolving = resolveDepthConfig(
    app(paths),
    noPath,
    new AbortController().signal,
  );
  paths["environment.depth.belowTransducer"] = { $source: "one", value: 2.5 };
  expect((await resolving)?.path).toBe("belowTransducer");
});

test("historical discovery prioritizes recency, rejects unproven sources and continues after failed paths", async () => {
  let unproven = false;
  const history = {
    getPaths: async () => [
      "environment.depth.belowTransducer",
      "environment.depth.belowSurface",
      "environment.depth.belowKeel",
    ],
    getValues: async ({ pathSpecs }: { pathSpecs: { path: string }[] }) => {
      const path = pathSpecs[0].path;
      if (path.endsWith("belowKeel")) throw new Error("no series");
      return {
        values: [{ path, $source: unproven ? undefined : "chosen" }],
        data: [
          [
            path.endsWith("belowSurface")
              ? "2026-01-02T00:00:00Z"
              : "2026-01-01T00:00:00Z",
            3,
          ],
        ],
      };
    },
  };
  const cfg = { ...noPath, sounder: { ...config.sounder, source: "chosen" } };
  expect(
    await recordedPath(app({}, history), cfg, new AbortController().signal),
  ).toBe("belowSurface");
  unproven = true;
  expect(
    await recordedPath(app({}, history), cfg, new AbortController().signal),
  ).toBeUndefined();
});

test("empty history discovery backs off rather than scanning every minute", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const controller = new AbortController();
  try {
    const getPaths = vi.fn(async () => []);
    const resolving = resolveDepthConfig(
      app({}, { getPaths }),
      noPath,
      controller.signal,
    );
    await vi.waitFor(() => expect(getPaths).toHaveBeenCalledTimes(1));
    clock.mockReturnValue(now + 61000);
    await vi.waitFor(() => expect(getPaths).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
    clock.mockReturnValue(now + 125000);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(getPaths).toHaveBeenCalledTimes(2);
    controller.abort();
    await resolving;
  } finally {
    controller.abort();
    clock.mockRestore();
  }
});

test("a zero in a bucket cannot hide positive history, including preferred responses without columns", async () => {
  const history = {
    getPaths: async () => ["environment.depth.belowSurface"],
    getValues: async ({
      pathSpecs,
    }: {
      pathSpecs: { aggregate: string }[];
    }) => ({
      data: [
        ["2026-01-01T00:00:00Z", pathSpecs[0].aggregate === "max" ? 3 : 0],
      ],
    }),
  };
  expect(
    await recordedPath(app({}, history), noPath, new AbortController().signal),
  ).toBe("belowSurface");
  expect(
    await recordedPath(
      app({}, history),
      { ...noPath, sounder: { ...config.sounder, source: "chosen" } },
      new AbortController().signal,
    ),
  ).toBeUndefined();
});
