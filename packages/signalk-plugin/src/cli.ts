#!/usr/bin/env node

import { toGeoJSON } from "./streams/geojson.js";
import { fromXyz } from "./streams/xyz.js";
import { pipeline } from "stream/promises";
import { correctForSensorPosition, toPrecision } from "./streams/transforms.js";
import { BathymetryData } from "./index.js";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import chain from "stream-chain";

const { configuration } = JSON.parse(
  readFileSync(
    join(homedir(), ".signalk", "plugin-config-data", "crowd-depth.json"),
  ).toString(),
);

export async function xyzToGeoJSON({
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const data = chain([
    input,
    fromXyz(),
    toPrecision(),
    correctForSensorPosition(configuration),
    // My sounder outputs 42949672.9 if it can't read data. Maximum known ocean depth is <11000m
    (data: BathymetryData) => (data.depth < 11000 ? data : null),
  ]);

  return pipeline(toGeoJSON(data), output);
}
