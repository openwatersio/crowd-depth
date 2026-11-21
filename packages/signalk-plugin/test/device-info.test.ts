import { expect, test } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { detectSensor } from "../src/device-info.js";

const app = {
  getPath: () => ({
    bus: {
      "12": {
        n2k: {
          manufacturerCode: "Vendor A",
          modelId: "Model A",
          canName: "stable-id",
        },
      },
      "13": { n2k: { manufacturerCode: "Vendor B", modelId: "Model B" } },
    },
  }),
} as unknown as ServerAPI;

test("uses the selected device by address or stable CAN name", () => {
  for (const source of ["bus.12", "bus.stable-id"]) {
    expect(detectSensor(app, source)).toEqual({
      make: "Vendor A",
      model: "Model A",
    });
  }
  expect(detectSensor(app, "bus.13")).toEqual({
    make: "Vendor B",
    model: "Model B",
  });
});

test("does not borrow identity from other devices", () => {
  for (const source of [undefined, "bus.99", "gpsd.GP", "derived-data"]) {
    expect(detectSensor(app, source)).toEqual({});
  }
});

test("ignores numeric manufacturer codes and malformed model names", () => {
  const malformed = {
    getPath: () => ({
      bus: { "1": { n2k: { manufacturerCode: 135, modelId: {} } } },
    }),
  } as unknown as ServerAPI;
  expect(detectSensor(malformed, "bus.1")).toEqual({
    make: undefined,
    model: undefined,
  });
});
