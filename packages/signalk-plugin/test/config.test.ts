import { expect, test } from "vitest";
import { ServerAPI } from "@signalk/server-api";
import { schema } from "../src/config.js";

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
