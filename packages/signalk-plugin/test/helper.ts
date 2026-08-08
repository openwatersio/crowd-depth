import { ServerAPI } from "@signalk/server-api";
import { Config, VesselInfo } from "../src/index.js";

export const vessel: VesselInfo = {
  uuid: "60ba2ee8-04ee-45e4-b723-d54ee031ea47",
  token: "test",
  mmsi: "123456789",
  name: "Test Vessel",
  type: "Sailing",
  loa: 10,
};

export const config: Config = {
  path: "depthFromTransducer",
  sounder: { x: 1, y: 2, z: 3 },
  gnss: { x: 1, y: 2, z: 3 },
  sharing: {
    anonymous: false,
  },
};

export const app = {
  debug: () => {},
  error: () => {},
  getDataDirPath: () => "",
  setPluginStatus: () => {},
  setPluginError: () => {},
} as unknown as ServerAPI;
