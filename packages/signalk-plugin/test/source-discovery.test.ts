import { afterEach, expect, test, vi } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { createSourceDiscovery } from "../src/source-discovery.js";

afterEach(() => vi.useRealTimers());
function setup(
  getValues = vi.fn().mockResolvedValue({
    values: [
      { path: "environment.depth.belowTransducer", $source: "canhat.35" },
      { path: "navigation.position", $source: "gpsd.GP" },
      { path: "navigation.position", $source: "gpsd.GP" },
      { path: "navigation.position" },
    ],
  }),
) {
  const app = {
    debug: vi.fn(),
    getHistoryApi: async () => ({
      getPaths: async () => [
        "navigation.position",
        "environment.depth.belowTransducer",
      ],
      getValues,
    }),
  } as unknown as ServerAPI;
  return { discover: createSourceDiscovery(app), getValues };
}

test("discovers distinct recorded sources without requiring live samples", async () => {
  const { discover, getValues } = setup();
  expect(await discover()).toEqual({
    "navigation.position": ["gpsd.GP"],
    "environment.depth.belowTransducer": ["canhat.35"],
  });
  expect(getValues.mock.calls[0]?.[0].sourcePolicy).toBe("all");
});

test("a slow lookup finishes in the background and is available on reload", async () => {
  vi.useFakeTimers();
  let complete!: (value: unknown) => void;
  const getValues = vi.fn(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const { discover } = setup(getValues);
  const first = discover();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await first).toEqual({});
  complete({ values: [{ path: "navigation.position", $source: "gpsd.GP" }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(await discover()).toEqual({ "navigation.position": ["gpsd.GP"] });
  expect(getValues).toHaveBeenCalledTimes(1);
});

test("provider failures do not prevent opening configuration", async () => {
  const { discover } = setup(vi.fn().mockRejectedValue(new Error("offline")));
  expect(await discover()).toEqual({});
});

test("a provider that was unavailable at startup retries without an hour-long cache delay", async () => {
  vi.useFakeTimers();
  const values = vi
    .fn()
    .mockRejectedValueOnce(new Error("starting"))
    .mockResolvedValue({
      values: [{ path: "navigation.position", $source: "gpsd.GP" }],
    });
  const { discover } = setup(values);
  expect(await discover()).toEqual({});
  await vi.advanceTimersByTimeAsync(5001);
  expect(await discover()).toEqual({ "navigation.position": ["gpsd.GP"] });
  await vi.advanceTimersByTimeAsync(60000);
  await discover();
  expect(values).toHaveBeenCalledTimes(2);
});
