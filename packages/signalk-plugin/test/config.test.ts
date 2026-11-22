import { describe, expect, test } from "vitest";
import { ServerAPI } from "@signalk/server-api";
import {
  depthReference,
  schema,
  uiSchema,
  selectDepth,
} from "../src/config.js";

// The server's sources tree keys devices by numeric bus address and uses
// camelCase n2k fields (see signalk-server's admin UI sourceLabels.ts).
// With useCanName, sourceRefs carry the hex CAN name instead of the address.
function mockApp(selfPaths: Record<string, unknown>, sources: unknown) {
  return {
    getSelfPath: (path: string) => selfPaths[path],
    getPath: (path: string) => (path === "sources" ? sources : undefined),
  } as unknown as ServerAPI;
}

function positionEnumNames(app: ServerAPI): string[] {
  const s = schema(app) as {
    properties: {
      gnss: { properties: { source: { enumNames: string[] } } };
    };
  };
  return s.properties.gnss.properties.source.enumNames;
}

test("labels sources keyed by numeric address", () => {
  const app = mockApp(
    {
      "navigation.position": { $source: "PICAN-M.35" },
    },
    {
      "PICAN-M": {
        type: "NMEA2000",
        "35": { n2k: { manufacturerCode: "Airmar", modelId: "DST200" } },
      },
    },
  );
  expect(positionEnumNames(app)).toEqual(["Airmar DST200 (PICAN-M.35)"]);
});

test("labels canName sourceRefs via the device's canName field", () => {
  const app = mockApp(
    {
      "navigation.position": {
        $source: "IPG100.c0788c00e7e04312",
        values: {
          "IPG100.c0788c00e7e04312": {},
          "IPG100.cb8cbe0be7e00b16": {},
        },
      },
    },
    {
      IPG100: {
        type: "NMEA2000",
        "35": {
          n2k: {
            manufacturerCode: "Furuno",
            modelId: "SCX-20",
            canName: "c0788c00e7e04312",
          },
        },
        "36": {
          n2k: {
            manufacturerCode: "Furuno",
            modelId: "FM-4850",
            canName: "cb8cbe0be7e00b16",
          },
        },
      },
    },
  );
  expect(positionEnumNames(app)).toEqual([
    "Furuno SCX-20 (IPG100.c0788c00e7e04312)",
    "Furuno FM-4850 (IPG100.cb8cbe0be7e00b16)",
  ]);
});

test("falls back to the raw sourceRef for unknown devices", () => {
  const app = mockApp(
    { "navigation.position": { $source: "gps-plugin" } },
    undefined,
  );
  expect(positionEnumNames(app)).toEqual(["gps-plugin"]);
});

test("does not require the transducer depth", () => {
  const s = schema(mockApp({}, {})) as {
    properties: { sounder: { required: string[] } };
  };
  expect(s.properties.sounder.required).not.toContain("z");
});

describe("depthReference", () => {
  const sounder = { x: 0, y: 0, z: 0.5, draft: 1.8 };

  test("depth below the surface is already from the waterline", () => {
    expect(depthReference({ path: "belowSurface", sounder })).toEqual({
      offset: 0,
      reference: "Waterline",
    });
  });

  test("adds the transducer depth when it is configured", () => {
    expect(depthReference({ path: "belowTransducer", sounder })).toEqual({
      offset: 0.5,
      reference: "Waterline",
    });
  });

  test("labels the transducer as the reference when its depth is unknown", () => {
    expect(
      depthReference({
        path: "belowTransducer",
        sounder: { x: 0, y: 0 },
      }),
    ).toEqual({ offset: 0, reference: "Transducer" });
  });

  test("adds the draft to a depth below the keel", () => {
    expect(depthReference({ path: "belowKeel", sounder })).toEqual({
      offset: 1.8,
      reference: "Waterline",
    });
  });

  test("labels a depth below the keel as unknown without a draft", () => {
    expect(
      depthReference({
        path: "belowKeel",
        sounder: { x: 0, y: 0, z: 0.5 },
      }),
    ).toEqual({ offset: 0, reference: "Unknown" });
  });
});

test("offers recorded sources after reboot without live depth data", () => {
  const s = schema(mockApp({}, {}), {
    "environment.depth.belowTransducer": ["canhat.35"],
    "navigation.position": ["gpsd.GP"],
  });
  expect(s.properties).not.toHaveProperty("path");
  expect(s.properties.sounder.properties.source.enum).toEqual(["canhat.35"]);
  expect(s.properties.gnss.properties.source.default).toBe("gpsd.GP");
});

test("preserves saved source choices even when absent from live data and history", () => {
  const app = mockApp({}, {});
  app.readPluginOptions = () => ({
    configuration: {
      path: "belowKeel",
      sounder: { source: "old.35" },
      gnss: { source: "old.GP" },
    },
  });
  const s = schema(app);
  expect(s.properties).not.toHaveProperty("path");
  expect(s.properties.sounder.properties.source.enum).toEqual(["old.35"]);
  expect(s.properties.gnss.properties.source.default).toBe("old.GP");
});

test("placeholders show only detected values and do not become saved defaults", () => {
  const app = mockApp(
    { "environment.depth.belowTransducer": { $source: "can.1" } },
    {
      can: { "1": { n2k: { manufacturerCode: "Airmar", modelId: "DT200" } } },
    },
  );
  expect(uiSchema(app).sounder).toEqual({
    make: { "ui:placeholder": "Airmar" },
    model: { "ui:placeholder": "DT200" },
  });
  expect(schema(app).properties.sounder.properties.make).not.toHaveProperty(
    "default",
  );
  expect(uiSchema(app).gnss.make["ui:placeholder"]).toBe("");
});

test("placeholders use the saved source, including sources discovered in history", () => {
  const app = mockApp(
    {},
    {
      can: {
        "1": { n2k: { manufacturerCode: "Airmar", modelId: "DT200" } },
        "2": { n2k: { manufacturerCode: "Garmin", modelId: "Other" } },
      },
    },
  );
  app.readPluginOptions = () => ({
    configuration: { sounder: { source: "can.2" } },
  });
  expect(
    uiSchema(app, { "environment.depth.belowTransducer": ["can.1"] }).sounder
      .model["ui:placeholder"],
  ).toBe("Other");
});

test("excludes derived-data from live, recorded and saved source choices", () => {
  const app = mockApp(
    {
      "environment.depth.belowSurface": {
        $source: "derived-data",
        values: { "derived-data": {}, "can.35": {} },
      },
    },
    {},
  );
  app.readPluginOptions = () => ({
    configuration: { sounder: { source: "derived-data" } },
  });
  const result = schema(app, {
    "environment.depth.belowSurface": ["derived-data", "can.35"],
    "navigation.position": ["derived-data", "gpsd.GP"],
  }).properties;
  expect(result.sounder.properties.source.enum).toEqual(["can.35"]);
  expect(result.sounder.properties.source.default).toBe("can.35");
  expect(result.gnss.properties.source.enum).toEqual(["gpsd.GP"]);
});

test("prefers transducer depth for the selected source across live data and history", () => {
  const app = mockApp(
    { "environment.depth.belowSurface": { $source: "can.2" } },
    {},
  );
  expect(
    selectDepth(app, "can.1", {
      "environment.depth.belowTransducer": ["can.1"],
      "environment.depth.belowSurface": ["can.1"],
    }),
  ).toEqual({ path: "belowTransducer", source: "can.1" });
  expect(selectDepth(app, "can.2")).toEqual({
    path: "belowSurface",
    source: "can.2",
  });
  expect(selectDepth(app, "can.3")).toBeUndefined();
});

test("falls back to surface then keel only when supplied by the selected source", () => {
  const app = mockApp({}, {});
  expect(
    selectDepth(app, "can.1", {
      "environment.depth.belowSurface": ["can.1"],
      "environment.depth.belowKeel": ["can.1"],
    })?.path,
  ).toBe("belowSurface");
  expect(
    selectDepth(app, "can.1", {
      "environment.depth.belowTransducer": ["derived-data"],
      "environment.depth.belowKeel": ["can.1"],
    })?.path,
  ).toBe("belowKeel");
  expect(
    selectDepth(app, undefined, {
      "environment.depth.belowTransducer": ["can.1", "can.2"],
    }),
  ).toBeUndefined();
});

test("GPS starts with source and shows selected receiver metadata as plain placeholders", () => {
  const app = mockApp(
    { "navigation.position": { $source: "can.10" } },
    {
      can: {
        "10": { n2k: { manufacturerCode: "Garmin", modelId: "GPS 19x" } },
      },
    },
  );
  expect(Object.keys(schema(app).properties.gnss.properties)[0]).toBe("source");
  expect(uiSchema(app).gnss).toEqual({
    make: { "ui:placeholder": "Garmin" },
    model: { "ui:placeholder": "GPS 19x" },
  });
  expect(schema(app).properties.gnss.properties.make).not.toHaveProperty(
    "default",
  );
});

test("preserves a saved depth reference and waits rather than silently switching it", () => {
  const app = mockApp({}, {});
  const recorded = {
    "environment.depth.belowTransducer": ["can.1"],
    "environment.depth.belowSurface": ["can.1"],
  };
  expect(selectDepth(app, "can.1", recorded, "belowSurface")?.path).toBe(
    "belowSurface",
  );
  expect(
    selectDepth(
      app,
      "can.1",
      {
        "environment.depth.belowTransducer": ["can.1"],
      },
      "belowSurface",
    ),
  ).toBeUndefined();
});
