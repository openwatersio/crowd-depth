import StreamFormData, { type SubmitOptions } from "form-data";
import { toXyz } from "../streams/xyz.js";
import { text } from "stream/consumers";
import type { VesselInfo } from "../metadata.js";
import type { Readable } from "stream";
import { Config } from "../config.js";
import pkg from "../../package.json" with { type: "json" };
import { correctForSensorPosition, toPrecision } from "../streams/index.js";
import chain from "stream-chain";
import createDebug from "debug";

const debug = createDebug("crowd-depth:noaa");

export type SubmissionResponse = {
  success: boolean;
  message: string;
  submissionIds: string[];
};

export function submitFormData(
  url: URL,
  prefix: string,
  metadata: Metadata,
  file: Readable,
  headers: Record<string, string> = {},
): Promise<SubmissionResponse> {
  return new Promise<SubmissionResponse>((resolve, reject) => {
    // Using external form-data package to support streaming
    const form = new StreamFormData();
    form.on("error", reject);

    form.append("metadataInput", JSON.stringify(metadata), {
      contentType: "application/json",
    });

    form.append("file", file, {
      contentType: "application/csv",
      filename: `${prefix}.csv`,
    });

    const options: SubmitOptions = {
      protocol: url.protocol === "https:" ? "https:" : "http:",
      host: url.hostname,
      path: url.pathname,
      port: url.port,
      method: "POST",
      headers,
    };

    debug("Submitting to %s", url.toString());

    form.submit(options, async (err, res) => {
      if (err) {
        debug("Error submitting form data: %O", err);
        form.destroy(err);
        return reject(err);
      }

      debug("Received response: %d %s", res.statusCode, res.statusMessage);

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        return reject(
          new Error(
            `POST to ${url} failed: ${res.statusCode} ${res.statusMessage}`,
          ),
        );
      }

      // Drain the response
      res.resume();
      resolve(JSON.parse(await text(res)));
    });
  });
}

export class NOAAReporter {
  constructor(
    public url: string,
    public config: Config,
    public vessel: VesselInfo,
  ) {}

  correctors() {
    return chain([correctForSensorPosition(this.config), toPrecision()]);
  }

  async submit(data: Readable) {
    const url = new URL("xyz", this.url);
    const metadata: Metadata = getMetadata(this.vessel, this.config);
    const { uuid } = this.vessel;
    const prefix = `${uuid}-${new Date().toISOString()}`;
    const file = chain([
      data,
      this.correctors(),
      toXyz({ includeHeading: false }),
    ]);

    return submitFormData(url, prefix, metadata, file, {
      Authorization: `Bearer ${this.vessel.token}`,
    });
  }
}

export type Metadata = ReturnType<typeof getMetadata>;

// https://www.ncei.noaa.gov/sites/g/files/anmtlf171/files/2024-04/SampleCSBFileFormats.pdf
export function getMetadata(info: VesselInfo, config: Config) {
  return {
    crs: {
      horizontal: {
        type: "EPSG",
        value: 4326,
      },
      vertical: "Transducer",
    },
    providerContactPoint: {
      orgName: "Open Water Software",
      email: "bathy@openwaters.io",
      logger: `${pkg.name} (${pkg.homepage})`,
      loggerVersion: pkg.version,
    },
    convention: "XYZ CSB 3.0",
    dataLicense: "CC0 1.0",
    platform: {
      uniqueID: `SIGNALK-${info.uuid}`,
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
          make: config.sounder?.make,
          model: config.sounder?.model,
          position: [
            config.sounder?.x ?? 0,
            config.sounder?.y ?? 0,
            config.sounder?.z ?? 0,
          ],
          draft: config.sounder?.draft,
          frequency: config.sounder?.frequency,
          transducer: config.sounder?.transducer,
        },
        {
          type: "GNSS",
          make: config.gnss?.make,
          model: config.gnss?.model,
          position: [
            config.gnss?.x ?? 0,
            config.gnss?.y ?? 0,
            config.gnss?.z ?? 0,
          ],
        },
      ],
      correctors: {
        positionReferencePoint: "Transducer",
        draftApplied: true,
        // "positionOffsetsDocumented": true,
        // "soundSpeedDocumented": true,
        // "dataProcessed": true,
        // "motionOffsetsApplied": true,
      },
    },
  };
}
