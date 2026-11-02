import { expect, test } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { settleSource } from "../../src/sources/settle.js";
import { createStatus } from "../../src/status.js";
import { BathymetrySource } from "../../src/types.js";
import { app } from "../helper.js";

const history = {
  createReader: () => undefined,
} as unknown as BathymetrySource;
const sqlite = { createReader: () => undefined } as unknown as BathymetrySource;

// Drives settleSource with a provider that answers from the given call on
// (never, when undefined), recording what the plugin would have started.
function setup({
  registersOnCall,
  recordError,
}: { registersOnCall?: number; recordError?: boolean } = {}) {
  let calls = 0;
  const recordings: AbortSignal[] = [];
  const messages: string[] = [];
  const controller = new AbortController();
  const status = createStatus({
    ...app,
    setPluginStatus: (m: string) => messages.push(m),
    setPluginError: (m: string) => messages.push(`Error: ${m}`),
  } as typeof app);
  const settled = (wait = Temporal.Duration.from({ seconds: 5 })) =>
    settleSource({
      findHistory: async () => {
        calls++;
        return registersOnCall !== undefined && calls >= registersOnCall
          ? history
          : undefined;
      },
      sqlite,
      record: (signal) => {
        recordings.push(signal);
        if (recordError)
          status.error(new Error("Collector stopped"), "collector");
      },
      status,
      wait,
      interval: Temporal.Duration.from({ milliseconds: 1 }),
      signal: controller.signal,
    });
  return { settled, recordings, messages, controller, status };
}

test("uses a provider that is there at startup, without recording", async () => {
  const { settled, recordings, status } = setup({ registersOnCall: 1 });
  expect(await settled()).toBe(history);
  expect(recordings).toHaveLength(0);
  expect(status.state).toMatchObject({ usingHistory: true, collecting: false });
});

test("records while waiting, then hands over to a late provider", async () => {
  const { settled, recordings, messages, status } = setup({
    registersOnCall: 4,
  });
  expect(await settled()).toBe(history);
  expect(recordings).toHaveLength(1);
  expect(recordings[0]!.aborted).toBe(true);
  expect(
    messages.some((m) => m.includes("Waiting for a history provider")),
  ).toBe(true);
  expect(status.state).toMatchObject({
    usingHistory: true,
    collecting: false,
    waitingForHistory: false,
  });
});

test("keeps recording to SQLite when no provider appears in time", async () => {
  const { settled, recordings, status } = setup();
  expect(await settled(Temporal.Duration.from({ milliseconds: 20 }))).toBe(
    sqlite,
  );
  expect(recordings[0]!.aborted).toBe(false);
  expect(status.state).toMatchObject({
    usingHistory: false,
    collecting: true,
    waitingForHistory: false,
  });
});

test("history handover clears an obsolete collector error while retaining reporter errors", async () => {
  const { settled, messages, status } = setup({
    registersOnCall: 4,
    recordError: true,
  });
  status.error(new Error("Reporter offline"), "reporter");
  expect(await settled()).toBe(history);
  expect(
    messages.some((message) => message.includes("Collector stopped")),
  ).toBe(true);
  expect(messages.at(-1)).toContain("Using history");
  expect(messages.at(-1)).toContain("Reporter offline");
  expect(messages.at(-1)).not.toContain("Collector stopped");
});

test("starts nothing when stopped during the first lookup", async () => {
  const { settled, recordings, controller } = setup();
  const result = settled();
  controller.abort();
  expect(await result).toBeUndefined();
  expect(recordings).toHaveLength(0);
});

test("stops recording when stopped while waiting", async () => {
  const { settled, recordings, controller } = setup();
  const result = settled(Temporal.Duration.from({ minutes: 10 }));
  await new Promise((r) => setTimeout(r, 10));
  expect(recordings).toHaveLength(1);
  controller.abort();
  expect(await result).toBeUndefined();
  expect(recordings[0]!.aborted).toBe(true);
});
