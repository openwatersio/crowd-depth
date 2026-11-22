import { expect, test, vi } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { getSensorInfo } from "../src/metadata.js";
import { getMetadata } from "../src/reporters/noaa.js";
import { config, vessel } from "./helper.js";
import * as gpsd from "../src/gpsd-info.js";

test("report detection follows explicit selections and otherwise server preference", async () => {
  const app = {
    getSelfPath: () => ({ $source: "bus.1" }),
    getPath: () => ({
      bus: {
        "1": { n2k: { manufacturerCode: "Preferred", modelId: "A" } },
        "2": { n2k: { manufacturerCode: "Selected", modelId: "B" } },
      },
    }),
  } as unknown as ServerAPI;
  const sensors = await getSensorInfo(app, {
    ...config,
    gnss: { ...config.gnss, source: "bus.2" },
  });
  expect(sensors.sounder.make).toBe("Preferred");
  expect(sensors.gnss.make).toBe("Selected");
  const metadata = getMetadata(
    { ...vessel, sensors },
    {
      ...config,
      sounder: {
        ...config.sounder,
        make: "Manual",
        model: " ",
        transducer: "P65",
      },
    },
  );
  expect(metadata.properties.platform.sensors[0]).toMatchObject({
    make: "Manual",
    model: "Unknown",
    transducer: "P65",
  });
});

test("NMEA identity never borrows fields from GPSD", async () => {
  const query = vi
    .spyOn(gpsd, "detectGpsdDetails")
    .mockResolvedValue({ make: "Wrong" });
  try {
    const app = {
      getSelfPath: () => ({ $source: "bus.1" }),
      getPath: () => ({ bus: { "1": { n2k: { modelId: "Receiver" } } } }),
    } as unknown as ServerAPI;
    expect((await getSensorInfo(app, config)).gnss.model).toBe("Receiver");
    expect(query).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
  }
});

test("anonymous metadata filters identifiers through the complete report path", async () => {
  const app = {
    getSelfPath: () => ({ $source: "bus.1" }),
    getPath: () => ({
      bus: {
        "1": {
          n2k: {
            manufacturerCode: "Vendor",
            modelId: "Model",
            modelSerialCode: "private",
            canName: "private",
          },
        },
      },
    }),
  } as unknown as ServerAPI;
  const cfg = { ...config, sharing: { anonymous: true } };
  const report = getMetadata(
    { ...vessel, sensors: await getSensorInfo(app, cfg) },
    cfg,
  );
  expect(JSON.stringify(report)).not.toContain("private");
  expect(report.properties.platform).not.toHaveProperty("name");
  const { default: Ajv } = await import("ajv/dist/2020.js");
  const { default: schema } = await import(
    "../../../docs/CSB-schema-3_1_0-2024-04.json",
    { with: { type: "json" } }
  );
  const { createGeoJSON } = await import("../src/reporters/noaa.js");
  const { Readable } = await import("node:stream");
  const { text } = await import("node:stream/consumers");
  const content = JSON.parse(
    await text(
      createGeoJSON(
        cfg,
        {
          ...vessel,
          sensors: await getSensorInfo(app, cfg),
        },
        Readable.from([]),
      ),
    ),
  );
  const validate = new Ajv({ strict: false }).compile(schema);
  expect(validate(content), JSON.stringify(validate.errors)).toBe(true);
});

test("manual missing fields and case differences retain compatible device details", () => {
  const sensors = {
    sounder: { make: "Airmar", model: "DT200", nmea2000: { productCode: 42 } },
    gnss: { gpsd: { driver: "u-blox", cycle: 1 } },
  };
  const report = getMetadata(
    { ...vessel, sensors },
    {
      ...config,
      sounder: { ...config.sounder, make: "airmar" },
      gnss: {
        ...config.gnss,
        make: "Receiver vendor",
        model: "Receiver model",
      },
    },
  );
  expect(report.properties.platform.sensors[0]).toHaveProperty(
    "nmea2000.productCode",
    42,
  );
  expect(report.properties.platform.sensors[1]).toHaveProperty(
    "gpsd.driver",
    "u-blox",
  );
});

test("populated NMEA and GPSD extensions validate in serialized CSB reports", async () => {
  const { default: Ajv } = await import("ajv/dist/2020.js");
  const { default: schema } = await import(
    "../../../docs/CSB-schema-3_1_0-2024-04.json",
    { with: { type: "json" } }
  );
  const { createGeoJSON } = await import("../src/reporters/noaa.js");
  const { Readable } = await import("node:stream");
  const { text } = await import("node:stream/consumers");
  const info = {
    ...vessel,
    sensors: {
      sounder: {
        make: "Vendor",
        model: "Model",
        nmea2000: {
          modelVersion: "HW2",
          softwareVersionCode: "3.1",
          productCode: 42,
        },
      },
      gnss: {
        gpsd: {
          driver: "NMEA0183",
          subtype: "Firmware",
          subtype1: "Hardware",
          cycle: 1,
        },
      },
    },
  };
  const content = JSON.parse(
    await text(createGeoJSON(config, info, Readable.from([]))),
  );
  const validate = new Ajv({ strict: false }).compile(schema);
  expect(validate(content), JSON.stringify(validate.errors)).toBe(true);
});
