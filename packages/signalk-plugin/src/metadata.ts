import { ServerAPI } from "@signalk/server-api";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { BATHY_URL } from "./constants.js";
import fetch from "./fetch.js";

export type Identity = {
  uuid: string;
  token: string;
};

export type VesselInfo = Identity & {
  mmsi?: string;
  imo?: string;
  name?: string;
  loa?: number;
  type?: string;
};

export async function getVesselInfo(app: ServerAPI): Promise<VesselInfo> {
  return {
    ...(await identify(app)),
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
    });
    if (!res.ok) {
      throw new Error(`Failed to identify: ${res.status} ${res.statusText}`);
    }
    identity = await res.json();
    app.debug(`UUID: ${identity.uuid}`);
    await writeFile(path, JSON.stringify(identity, null, 2), "utf-8");
  }

  return identity;
}
