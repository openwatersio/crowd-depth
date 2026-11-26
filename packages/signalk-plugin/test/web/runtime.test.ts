import { afterEach, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({
  call: vi.fn(),
  subscribe: vi.fn().mockResolvedValue(undefined),
  hasCapability: vi.fn((capability: string) => capability === "units"),
}));

vi.mock("signalk-plotterext-bus/extension", () => ({
  connectExtension: async () => host,
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function start() {
  vi.useFakeTimers();
  vi.resetModules();
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  await import("../../web/runtime.js");
  await vi.advanceTimersByTimeAsync(0);
}

const states = () =>
  host.call.mock.calls
    .filter(([method]) => method === "overlay.setState")
    .map(([, params]) => params.values);

test("soundings and contours follow unit changes without reloading or redundant redraws", async () => {
  let depth = "m";
  host.call.mockImplementation(async (method) =>
    method === "units.get" ? { units: { depth } } : {},
  );
  await start();
  await vi.advanceTimersByTimeAsync(2000);
  expect(states()).toHaveLength(1);

  depth = "foot";
  await vi.advanceTimersByTimeAsync(2000);
  await vi.advanceTimersByTimeAsync(2000);
  expect(states()).toEqual([
    { depthLabel: "depth_m", metresPerUnit: 1, contourUnit: "m" },
    { depthLabel: "depth_ft", metresPerUnit: 0.3048, contourUnit: "ft" },
  ]);

  depth = "m";
  await vi.advanceTimersByTimeAsync(2000);
  expect(states()).toHaveLength(3);
  expect(states().at(-1)).toEqual({
    depthLabel: "depth_m",
    metresPerUnit: 1,
    contourUnit: "m",
  });
});

test("retries a failed unit update on the next poll", async () => {
  let attempts = 0;
  host.call.mockImplementation(async (method) => {
    if (method === "units.get") return { units: { depth: "foot" } };
    if (method === "overlay.setState" && ++attempts <= 2)
      throw new Error("Overlay not ready");
    return {};
  });
  await start();
  expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(attempts).toBe(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(attempts).toBe(3);
  await vi.advanceTimersByTimeAsync(2000);
  expect(attempts).toBe(3);
});

test("history historyPreview publishes on the first poll without waiting for tile refresh", async () => {
  host.call.mockResolvedValue({});
  await start();
  const historyPreview = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "history:1:2",
        geometry: { type: "Point", coordinates: [-80, 26] },
        properties: { depth_m: 6 },
      },
    ],
  };
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      rev: 1,
      tiles: [],
      historyPreview,
      provisional: { features: [] },
    }),
  } as Response);
  await vi.advanceTimersByTimeAsync(2000);
  expect(host.call).toHaveBeenCalledWith("overlay.setData", {
    overlayId: "depth",
    source: "historyPreview",
    data: historyPreview,
  });
  expect(
    host.call.mock.calls.filter(([m]) => m === "overlay.refresh"),
  ).toHaveLength(0);
  const writes = () =>
    host.call.mock.calls.filter(
      ([m, p]) => m === "overlay.setData" && p.source === "historyPreview",
    );
  expect(writes()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(writes()).toHaveLength(1);
});

test("history historyPreview survives a batched or failed replacement refresh", async () => {
  host.call.mockResolvedValue({});
  await start();
  const feature = {
    id: "history:1:2",
    type: "Feature",
    geometry: { type: "Point", coordinates: [-80, 26] },
    properties: { depth_m: 6 },
  };
  let reply = {
    rev: 1,
    tiles: [] as number[][],
    all: false,
    refreshMs: 5000,
    historyPreview: { type: "FeatureCollection", features: [feature] },
    provisional: { features: [] },
  };
  vi.mocked(fetch).mockImplementation(
    async () => ({ ok: true, json: async () => reply }) as Response,
  );
  await vi.advanceTimersByTimeAsync(2000);
  reply = {
    ...reply,
    rev: 2,
    all: true,
    historyPreview: { type: "FeatureCollection", features: [] },
  };
  await vi.advanceTimersByTimeAsync(2000);
  const writes = () =>
    host.call.mock.calls.filter(
      ([m, p]) => m === "overlay.setData" && p.source === "historyPreview",
    );
  expect(writes().at(-1)![1].data.features).toEqual([feature]);
  host.call.mockImplementation(async (method) => {
    if (method === "overlay.refresh") throw new Error("not ready");
    return {};
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(writes().at(-1)![1].data.features).toEqual([feature]);
  host.call.mockResolvedValue({});
  await vi.advanceTimersByTimeAsync(2000);
  expect(writes().at(-1)![1].data.features).toEqual([]);
});

test("an unanswered units request cannot block startup or live polling", async () => {
  host.call.mockImplementation((method) =>
    method === "units.get" ? new Promise(() => {}) : Promise.resolve({}),
  );
  await start();
  const first = vi.mocked(fetch).mock.calls.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(first);
  expect(
    host.call.mock.calls.filter(([method]) => method === "units.get"),
  ).toHaveLength(1);
});

test("QC rejection retires history historyPreview even without a tile revision change", async () => {
  host.call.mockResolvedValue({});
  await start();
  const feature = { id: "history:1:2" };
  let features = [feature];
  vi.mocked(fetch).mockImplementation(
    async () =>
      ({
        ok: true,
        json: async () => ({
          rev: 1,
          tiles: [],
          refreshMs: 5000,
          historyPreviewRevision: features.length ? "before" : "after",
          historyPreview: { type: "FeatureCollection", features },
          provisional: { features: [] },
        }),
      }) as Response,
  );
  await vi.advanceTimersByTimeAsync(2000);
  features = [];
  await vi.advanceTimersByTimeAsync(6000);
  expect(host.call).toHaveBeenCalledWith("overlay.refresh", {
    overlayId: "depth",
    source: "cells",
  });
  const writes = host.call.mock.calls.filter(
    ([m, p]) => m === "overlay.setData" && p.source === "historyPreview",
  );
  expect(writes.at(-1)![1].data.features).toEqual([]);
  expect(String(vi.mocked(fetch).mock.calls.at(-1)![0])).toContain(
    "historyPreviewRevision=after",
  );
});
