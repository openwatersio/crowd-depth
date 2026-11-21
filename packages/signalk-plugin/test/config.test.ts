import { describe, expect, test, vi } from "vitest";
import { ServerAPI } from "@signalk/server-api";
import { depthReference, schema } from "../src/config.js";

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

test("survives a JSON round trip before the vessel reports any data", () => {
  // The server stores the schema as JSON, which drops undefined values.
  const s = schema(mockApp({}, {}));
  expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  expect(s.properties.sounder.properties.x).not.toHaveProperty("default");
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

test("identity placeholders use saved selections and leave configuration fields intact", async () => {
  const { uiSchema } = await import("../src/config.js");
  const app = mockApp(
    { "navigation.position": { $source: "bus.1" } },
    {
      bus: {
        "1": { n2k: { manufacturerCode: "First", modelId: "GPS 1" } },
        "2": { n2k: { manufacturerCode: "Second", modelId: "GPS 2" } },
      },
    },
  );
  app.readPluginOptions = () =>
    ({ configuration: { gnss: { source: "bus.2" } } }) as ReturnType<
      ServerAPI["readPluginOptions"]
    >;
  const before = schema(app);
  expect((await uiSchema(app)).gnss).toEqual({
    make: { "ui:placeholder": "Second" },
    model: { "ui:placeholder": "GPS 2" },
  });
  expect(schema(app)).toEqual(before);
  expect(before.properties.gnss.required).toEqual(["x", "y", "z"]);
  expect(before.properties).toHaveProperty("path");
  expect(before.properties.gnss.properties.make).not.toHaveProperty("default");
});

test("identity placeholders are optional when no devices or server settings are available", async () => {
  const { uiSchema } = await import("../src/config.js");
  expect(await uiSchema(mockApp({}, undefined))).toEqual({
    sounder: {
      make: { "ui:placeholder": "" },
      model: { "ui:placeholder": "" },
    },
    gnss: { make: { "ui:placeholder": "" }, model: { "ui:placeholder": "" } },
  });
});

test("implicit sounder hints follow the saved depth path", async () => {
  const { uiSchema } = await import("../src/config.js");
  const app = mockApp(
    {
      "environment.depth.belowSurface.value": 5,
      "environment.depth.belowSurface": { $source: "bus.1" },
      "environment.depth.belowTransducer.value": 4,
      "environment.depth.belowTransducer": { $source: "bus.2" },
    },
    {
      bus: {
        "1": { n2k: { manufacturerCode: "Surface", modelId: "One" } },
        "2": { n2k: { manufacturerCode: "Transducer", modelId: "Two" } },
      },
    },
  );
  app.readPluginOptions = () =>
    ({ configuration: { path: "belowTransducer" } }) as ReturnType<
      ServerAPI["readPluginOptions"]
    >;
  expect(schema(app).properties.sounder.properties.source).toMatchObject({
    default: "bus.2",
    enum: ["bus.2"],
  });
  expect((await uiSchema(app)).sounder).toEqual({
    make: { "ui:placeholder": "Transducer" },
    model: { "ui:placeholder": "Two" },
  });
});

test("does not mix a known NMEA model with a GPSD manufacturer", async () => {
  const { uiSchema } = await import("../src/config.js");
  const gpsd = await import("../src/gpsd-info.js");
  const query = vi
    .spyOn(gpsd, "cachedGpsdSensor")
    .mockReturnValue({ make: "Garmin" });
  try {
    const app = mockApp(
      { "navigation.position": { $source: "bus.1" } },
      {
        bus: { "1": { n2k: { modelId: "Receiver" } } },
      },
    );
    expect((await uiSchema(app)).gnss).toEqual({
      make: { "ui:placeholder": "" },
      model: { "ui:placeholder": "Receiver" },
    });
    expect(query).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
  }
});

test("saved sources remain selectable with no live data", async () => {
  const { uiSchema } = await import("../src/config.js");
  const app = mockApp({}, {});
  app.readPluginOptions = () =>
    ({
      configuration: {
        path: "belowKeel",
        sounder: { source: "offline.depth" },
        gnss: { source: "offline.gps" },
      },
    }) as ReturnType<ServerAPI["readPluginOptions"]>;
  const fields = schema(app).properties;
  expect(fields.path.default).toBe("belowKeel");
  expect(fields.sounder.properties.source).toMatchObject({
    default: "offline.depth",
    enum: ["offline.depth"],
  });
  expect(fields.gnss.properties.source).toMatchObject({
    default: "offline.gps",
    enum: ["offline.gps"],
  });
  expect(uiSchema(app)).not.toBeInstanceOf(Promise);
});
