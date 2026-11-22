import { expect, test } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { detectSensor } from "../src/device-info.js";

const device = {
  manufacturerCode: "Airmar",
  modelId: "DT200",
  modelVersion: "IDTP65-40-1,HW2:3,OEM0",
  softwareVersionCode: "4.003,4.004",
  productCode: 5602,
  modelSerialCode: "A000GYRA",
  canName: "c078820010eb32c0",
};
const app = {
  getPath: () => ({
    canhat: {
      "35": { n2k: device },
      "36": { n2k: { manufacturerCode: "Garmin", modelId: "GPS" } },
    },
  }),
} as unknown as ServerAPI;

test("reports the selected device's identity without guessing a retail model", () => {
  expect(detectSensor(app, "canhat.35", false)).toEqual({
    make: "Airmar",
    model: "DT200",
    nmea2000: {
      modelId: "DT200",
      modelVersion: device.modelVersion,
      softwareVersionCode: device.softwareVersionCode,
      productCode: 5602,
      modelSerialCode: "A000GYRA",
      canName: device.canName,
    },
  });
  expect(detectSensor(app, `canhat.${device.canName}`, false)).toEqual(
    detectSensor(app, "canhat.35", false),
  );
});

test("anonymous reports exclude hardware identifiers but retain model and firmware", () => {
  const result = detectSensor(app, "canhat.35", true);
  expect(result.nmea2000?.modelSerialCode).toBeUndefined();
  expect(result.nmea2000?.canName).toBeUndefined();
  expect(result.nmea2000?.modelVersion).toBe(device.modelVersion);
});

test("missing and non-NMEA sources do not borrow another device's metadata", () => {
  for (const source of [undefined, "canhat.99", "gpsd.GP", "derived-data"]) {
    expect(detectSensor(app, source, false)).toEqual({});
  }
});

test("ignores malformed fields rather than sending invalid metadata", () => {
  const invalid = {
    getPath: () => ({
      bus: {
        "1": {
          n2k: {
            manufacturerCode: 135,
            modelId: " ",
            productCode: NaN,
            modelVersion: {},
          },
        },
      },
    }),
  } as unknown as ServerAPI;
  expect(
    JSON.parse(JSON.stringify(detectSensor(invalid, "bus.1", false))),
  ).toEqual({ nmea2000: {} });
});
