import { detectSensorDetails, type SensorInfo } from "./device-info.js";
import { detectGpsdDetails } from "./gpsd-info.js";
import { resolveSource, type Config } from "./config.js";
import { ServerAPI } from "@signalk/server-api";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { BATHY_URL } from "./constants.js";
import fetch from "./fetch.js";
import { SubmissionError } from "./reporters/noaa.js";

export type Identity = {
  uuid: string;
  token: string;
};

export type VesselInfo = Identity & {
  mmsi?: string;
  imo?: string;
  name?: string;
  sensors?: { sounder: SensorInfo; gnss: SensorInfo };
  loa?: number;
  type?: string;
};

export async function getVesselInfo(
  app: ServerAPI,
  signal?: AbortSignal,
  config?: Config,
): Promise<VesselInfo> {
  return {
    ...(await identify(app, BATHY_URL, signal)),
    ...(config ? { sensors: await getSensorInfo(app, config) } : {}),
    // @ts-expect-error remove after next signalk release
    mmsi: app.config.vesselMMSI,
    imo: app.getSelfPath("registrations.imo") as string | undefined,
    name: app.getSelfPath("name") as string | undefined,
    loa: (app.getSelfPath("design.length.value") as { overall?: number })
      ?.overall,
    type: (app.getSelfPath("design.aisShipType.value") as { name?: string })
      ?.name,
  };
}

export async function identify(
  app: ServerAPI,
  url = BATHY_URL,
  signal?: AbortSignal,
): Promise<Identity> {
  const path = join(app.getDataDirPath(), "identity.json");

  let identity: Identity;

  try {
    identity = JSON.parse(await readFile(path, "utf-8"));
    app.debug(`Loaded identity from ${path}: ${identity.uuid}`);
  } catch {
    app.debug(`Identifying with ${url}`);
    const res = await fetch(new URL("identify", url).toString(), {
      method: "POST",
      signal,
    });
    if (!res.ok) {
      throw new SubmissionError(
        `Failed to identify: ${res.status} ${res.statusText}`,
        res.status,
        await res.text(),
      );
    }
    identity = await res.json();
    signal?.throwIfAborted();
    app.debug(`UUID: ${identity.uuid}`);
    await writeFile(path, JSON.stringify(identity, null, 2), "utf-8");
  }

  return identity;
}

/** Metadata describes the selected devices at report time, not reconstructed history. */
export async function getSensorInfo(app: ServerAPI, config: Config) {
  const anonymous = Boolean(config.sharing?.anonymous);
  const sounder = detectSensorDetails(
    app,
    resolveSource(
      app,
      config.sounder.source,
      `environment.depth.${config.path}`,
    ),
    anonymous,
  );
  const gpsSource = resolveSource(
    app,
    config.gnss.source,
    "navigation.position",
  );
  let gnss = detectSensorDetails(app, gpsSource, anonymous);
  if (!gnss.nmea2000) gnss = await detectGpsdDetails(app, gpsSource, anonymous);
  return { sounder, gnss };
}
