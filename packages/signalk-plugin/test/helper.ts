import { ServerAPI } from "@signalk/server-api";
import { Config, VesselInfo } from "../src/index.js";
import { TRL_HEADER_SIZE, TRL_RECORD_SIZE } from "../src/streams/realbathy.js";

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

export type TrlRecord = {
  lat: number;
  lon: number;
  depthCm: number;
  seconds: number;
};

/** Encodes records the way the MFD writes them to a `.trl` file. */
export function trl(records: TrlRecord[]) {
  const buffer = new Uint8Array(
    TRL_HEADER_SIZE + records.length * TRL_RECORD_SIZE,
  );
  const view = new DataView(buffer.buffer);
  records.forEach(({ lat, lon, depthCm, seconds }, i) => {
    const offset = TRL_HEADER_SIZE + i * TRL_RECORD_SIZE;
    view.setInt32(offset, Math.round(lat * 1e5), true);
    view.setInt32(offset + 4, Math.round(lon * 1e5), true);
    view.setUint32(offset + 8, depthCm, true);
    view.setUint16(offset + 12, 0xffff, true);
    view.setUint32(offset + 16, seconds, true);
  });
  return buffer;
}
