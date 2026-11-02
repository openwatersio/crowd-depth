import { text } from "stream/consumers";
import type { VesselInfo } from "../metadata.js";
import { Readable, addAbortSignal } from "stream";
import { Config, depthReference } from "../config.js";
import pkg from "../../package.json" with { type: "json" };
import {
  correctForSensorPosition,
  toGeoJSON,
  toPrecision,
} from "../streams/index.js";
import chain from "stream-chain";
import createDebug from "debug";
import fetch from "../fetch.js";

const debug = createDebug("crowd-depth:noaa");

export type SubmissionResponse = {
  success: boolean;
  message: string;
  submissionIds: string[];
};

/** Thrown when the upstream service rejects a submission. */
export class SubmissionError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
    this.name = "SubmissionError";
  }

  get permanent() {
    if (this.status === 413) return true;
    if (![400, 401, 403, 413, 426].includes(this.status)) return false;
    try {
      const body = JSON.parse(this.body);
      return (
        body?.success === false &&
        typeof body.message === "string" &&
        (this.status !== 400 ||
          body.message === "Missing or invalid User-Agent")
      );
    } catch {
      return false;
    }
  }
}

/**
 * Human-readable summary of a submission failure, surfacing the server's own
 * error message and submission id (for looking up the archived result) when
 * the response body is the API's JSON error shape.
 */
export function describeSubmissionError(err: unknown): string {
  if (err instanceof SubmissionError) {
    try {
      const { message, submissionId } = JSON.parse(err.body);
      if (message) {
        return submissionId
          ? `${message} (submission: ${submissionId})`
          : message;
      }
    } catch {
      // Body is not JSON; fall through to the raw error message
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export async function submitFormData(
  url: URL,
  prefix: string,
  metadata: object,
  file: Readable,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
  generationTimeout?: number,
): Promise<SubmissionResponse> {
  signal?.throwIfAborted();
  let contents: string;
  if (!signal && generationTimeout === undefined) {
    contents = await text(file);
  } else {
    const controller = new AbortController();
    const preparing = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    addAbortSignal(preparing, file);
    const timeout =
      generationTimeout === undefined
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                new Error(
                  "GeoJSON generation timed out; raise BATHY_REPORT_TIMEOUT for slow storage",
                ),
              ),
            generationTimeout,
          );
    try {
      contents = await text(file);
    } catch (err) {
      if (preparing.aborted) throw preparing.reason;
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
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
    new Blob([contents], { type: "application/geo+json" }),
    `${prefix}.geojson`,
  );

  debug("Submitting to %s", url.toString());

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: form,
    signal,
  });

  debug("Received response: %d %s", response.status, response.statusText);

  if (!response.ok) {
    // Keep the body out of the message to avoid nested dumps when errors are
    // re-reported; it is preserved in err.body and the archived result
    const body = await response.text();
    throw new SubmissionError(
      `POST to ${url} failed: ${response.status} ${response.statusText}`,
      response.status,
      body,
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
  signal?: AbortSignal,
  generationTimeout?: number,
) {
  signal?.throwIfAborted();
  const url = new URL("geojson", endpoint);
  const headers = { Authorization: `Bearer ${vessel.token}` };
  const body = createGeoJSON(config, vessel, data);
  const uniqueID = toUniqueID(vessel);

  try {
    return await submitFormData(
      url,
      vessel.uuid,
      { uniqueID },
      body,
      headers,
      signal,
      generationTimeout,
    );
  } finally {
    body.destroy();
    data.destroy();
  }
}

export type Metadata = ReturnType<typeof getMetadata>;

// https://www.ncei.noaa.gov/sites/g/files/anmtlf171/files/2024-04/SampleCSBFileFormats.pdf
export function getMetadata(info: VesselInfo, config: Config) {
  const uniqueID = toUniqueID(info);
  const reference =
    POSITION_REFERENCE === "Transducer"
      ? sounderLocation(config)
      : gnssLocation(config);
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
        verticalReferenceOfDepth: depthReference(config).reference,
        vesselPositionReferencePoint: POSITION_REFERENCE,
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
            position: sensorPosition(sounderLocation(config), reference),
            draft: config.sounder.draft,
            frequency: config.sounder.frequency,
          },
          {
            type: "GNSS",
            make: config.gnss.make ?? "Unknown",
            model: config.gnss.model ?? "Unknown",
            position: sensorPosition(gnssLocation(config), reference),
          },
        ],
        // Positions are corrected for GNSS/sounder offsets; soundings that
        // can't be corrected are dropped (see correctForSensorPosition)
        positionOffsetsDocumented: true,
        // Data has not ben adjusted for tides, etc.
        dataProcessed: false,
      },
    },
  };
}

/**
 * Where submitted positions are reported for: they are corrected from the GNSS
 * antenna to the transducer before submission (see correctForSensorPosition).
 */
export const POSITION_REFERENCE = "Transducer";

/** A point on the vessel: metres from the bow, to starboard of the centreline, and below the waterline. */
export type VesselLocation = {
  fromBow: number;
  starboard: number;
  down: number;
};

export function sounderLocation({
  sounder,
}: Pick<Config, "sounder">): VesselLocation {
  return {
    fromBow: sounder.y ?? 0,
    starboard: sounder.x ?? 0,
    // The transducer's depth below the waterline
    down: sounder.z ?? 0,
  };
}

export function gnssLocation({ gnss }: Pick<Config, "gnss">): VesselLocation {
  return {
    fromBow: gnss.y ?? 0,
    starboard: gnss.x ?? 0,
    // The antenna's height above the waterline
    down: -(gnss.z ?? 0),
  };
}

/**
 * A sensor's offset from the position reference point as the CSB convention
 * wants it (IHO B-12 Table 3): metres, positive towards the bow, to starboard
 * and down. The plugin's settings measure from the bow and the waterline
 * instead, so "from bow" grows aft and the antenna height grows up.
 */
export function sensorPosition(
  sensor: VesselLocation,
  reference: VesselLocation,
): [number, number, number] {
  // `+ 0` turns a -0 (the reference sensor itself) into 0.
  return [
    reference.fromBow - sensor.fromBow + 0,
    sensor.starboard - reference.starboard + 0,
    sensor.down - reference.down + 0,
  ];
}

export function toUniqueID(info: VesselInfo) {
  return `SIGNALK-${info.uuid}`;
}
