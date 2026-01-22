import { text } from "stream/consumers";
import type { VesselInfo } from "../metadata.js";
import { Readable } from "stream";
import { Config } from "../config.js";
import pkg from "../../package.json" with { type: "json" };
import {
  correctForSensorPosition,
  toGeoJSON,
  toPrecision,
} from "../streams/index.js";
import chain from "stream-chain";
import createDebug from "debug";

const debug = createDebug("crowd-depth:noaa");

export type SubmissionResponse = {
  success: boolean;
  message: string;
  submissionIds: string[];
};

export async function submitFormData(
  url: URL,
  prefix: string,
  metadata: object,
  file: Readable,
  headers: Record<string, string> = {},
): Promise<SubmissionResponse> {
  const form = new FormData();

  form.append(
    "metadataInput",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );

  // The FormData api can't handle a stream and needs the full blob to
  // determine the length for the multipart boundary. This previously
  // used chunked encoding, but Vercel chokes on chunked multipart forms.
  form.append(
    "file",
    new Blob([await text(file)], { type: "application/geo+json" }),
    `${prefix}.geojson`,
  );

  debug("Submitting to %s", url.toString());

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: form,
  });

  debug("Received response: %d %s", response.status, response.statusText);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `POST to ${url} failed: ${response.status} ${response.statusText}\n${body}`,
    );
  }

  return response.json();
}

export function createGeoJSON(
  config: Config,
  vessel: VesselInfo,
  data: Readable,
) {
  return toGeoJSON(
    chain([data, correctForSensorPosition(config), toPrecision()]),
    getMetadata(vessel, config),
  );
}

export async function submitGeoJSON(
  endpoint: string,
  config: Config,
  vessel: VesselInfo,
  data: Readable,
) {
  const url = new URL("geojson", endpoint);
  const headers = { Authorization: `Bearer ${vessel.token}` };
  const body = createGeoJSON(config, vessel, data);
  const uniqueID = toUniqueID(vessel);

  return submitFormData(url, vessel.uuid, { uniqueID }, body, headers);
}

export type Metadata = ReturnType<typeof getMetadata>;

// https://www.ncei.noaa.gov/sites/g/files/anmtlf171/files/2024-04/SampleCSBFileFormats.pdf
export function getMetadata(info: VesselInfo, config: Config) {
  const uniqueID = toUniqueID(info);
  const crs = "EPSG:4326";

  return {
    crs: {
      properties: {
        name: crs,
      },
    },
    properties: {
      trustedNode: {
        providerOrganizationName: "Open Water Software",
        providerEmail: "bathy@openwaters.io",
        uniqueVesselID: uniqueID,
        convention: "GeoJSON CSB 3.1",
        dataLicense: "CC0 1.0",
        providerLogger: `${pkg.name} (${pkg.homepage})`,
        providerLoggerVersion: pkg.version,
        navigationCRS: crs,
        verticalReferenceOfDepth: "Waterline",
        vesselPositionReferencePoint: "Transducer",
      },
      platform: {
        uniqueID,
        ...(config.sharing.anonymous
          ? {}
          : {
              type: info.type,
              name: info.name,
              length: info.loa,
              IDType: info.mmsi ? "MMSI" : info.imo ? "IMO" : undefined,
              IDNumber: info.mmsi ?? info.imo,
            }),
        sensors: [
          {
            type: "Sounder",
            make: config.sounder.make ?? "Unknown",
            model: config.sounder.model ?? "Unknown",
            position: [
              config.sounder.x ?? 0,
              config.sounder.y ?? 0,
              config.sounder.z ?? 0,
            ],
            draft: config.sounder.draft,
            frequency: config.sounder.frequency,
          },
          {
            type: "GNSS",
            make: config.gnss.make ?? "Unknown",
            model: config.gnss.model ?? "Unknown",
            position: [
              config.gnss.x ?? 0,
              config.gnss.y ?? 0,
              config.gnss.z ?? 0,
            ],
          },
        ],
        // Positions have been corrected for GNSS/sounder offsets
        positionOffsetsDocumented: true,
        // Data has not ben adjusted for tides, etc.
        dataProcessed: false,
      },
    },
  };
}

export function toUniqueID(info: VesselInfo) {
  return `SIGNALK-${info.uuid}`;
}
