import { Router } from "express";
import type { IRouter, NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import busboy from "busboy";
import { buffer, text } from "stream/consumers";
import { submitFormData, SubmissionError } from "crowd-depth";
import { Readable } from "stream";
import { createS3Storage, S3Config, type Storage } from "./s3.js";
import semver from "semver";
import asyncHandler from "express-async-handler";
import { getLogger } from "./logger.js";

const logger = getLogger("api");

// Validate required environment variables in production
if (process.env.NODE_ENV === "production") {
  if (!process.env.BATHY_JWT_SECRET)
    throw new Error("Missing BATHY_JWT_SECRET environment variable.");
  if (!process.env.NOAA_CSB_TOKEN)
    throw new Error("Missing NOAA_CSB_TOKEN environment variable.");
}

const {
  BATHY_JWT_SECRET = "test",
  NOAA_CSB_URL = "https://www.ngdc.noaa.gov/ingest-external/upload/csb/test/",
  NOAA_CSB_TOKEN = "test",
} = process.env;

export const MIN_CLIENT_VERSION = "1.0.1";

// The upload is held in memory to reach both storage and NOAA, so it is capped
// well above the ~3 MB real vessels send.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type APIOptions = {
  url?: string;
  token?: string;
  env?: Record<string, string>;
  storage?: Storage | null;
};

export function createApi(options: APIOptions = {}): IRouter {
  const router = Router();
  registerWithRouter(router, options);
  return router;
}

export function registerWithRouter(router: IRouter, options: APIOptions = {}) {
  const {
    url = NOAA_CSB_URL,
    token = NOAA_CSB_TOKEN,
    env = process.env,
  } = options;

  logger.info("API configured to use NOAA CSB URL: %s", url);

  const storage = options.storage ?? createS3Storage(env as S3Config);

  router.get("/", (req, res) => {
    res.json({ success: true, message: "API is reachable" });
  });

  router.post("/identify", (req, res) => {
    res.json(createIdentity());
  });

  /**
   * API to proxy requests to NOAA CSB XYZ upload endpoint, with authentication.
   *
   * @see "Guidance for Submitting CSB Data to the IHO DCDB" via
   * https://www.ncei.noaa.gov/products/crowdsourced-bathymetry
   * (the direct PDF link has percent-encoded characters that trip
   * Cloudflare's WAF when uploaded in source maps)
   */
  router.post(
    "/geojson",
    verifyIdentity,
    verifyClientVersion,
    asyncHandler(async (req, res) => {
      let metadata: MultipartMetadata;
      let data: Buffer;

      try {
        [metadata, data] = await getMultipartData(req);
      } catch (error) {
        logger.error(error);
        res
          .status(error instanceof PayloadTooLargeError ? 413 : 400)
          .json({ success: false, message: (error as Error).message });
        return;
      }

      // Validate that the uniqueID matches the identity UUID
      const { uuid } = res.locals;
      const uniqueID = metadata?.uniqueID;
      if (uniqueID !== `SIGNALK-${uuid}`) {
        res.status(403).json({ success: false, message: "Invalid uniqueID" });
        return;
      }

      const bytes = data.byteLength;

      try {
        // Store the data before submitting so a copy is kept even when NOAA
        // rejects it. Failing here fails the request so the client retries.
        const key = await storage?.store(uuid, data);

        // Record the outcome next to the stored data; diagnosable long after
        // Vercel's log retention expires.
        const recordResult = (result: object) =>
          key
            ? storage?.storeResult(key, result).catch((err) => {
                logger.error(err, "Failed to store submission result to S3");
              })
            : undefined;

        const started = Date.now();
        try {
          const submission = await submitFormData(
            new URL("geojson", url),
            uuid,
            metadata,
            Readable.from([data]),
            {
              "x-auth-token": token,
            },
          );
          const durationMs = Date.now() - started;

          logger.info(
            { uuid, uniqueID, bytes, durationMs },
            "NOAA submission succeeded",
          );
          await recordResult({
            success: true,
            uuid,
            uniqueID,
            bytes,
            durationMs,
            submission,
          });

          res.json(submission);
        } catch (err) {
          const durationMs = Date.now() - started;
          const upstream = err instanceof SubmissionError;
          const noaaStatus = upstream ? err.status : undefined;

          logger.error(
            { err, uuid, uniqueID, bytes, durationMs, noaaStatus },
            "NOAA submission failed",
          );
          await recordResult({
            success: false,
            uuid,
            uniqueID,
            bytes,
            durationMs,
            noaaStatus,
            noaaBody: upstream ? err.body : undefined,
            message: (err as Error).message,
          });

          // 502 distinguishes upstream NOAA failures from bugs in this API.
          // submissionId is the storage key of the archived data + result.
          res.status(upstream ? 502 : 500).json({
            success: false,
            message: (err as Error).message,
            submissionId: key,
          });
        }
      } catch (err) {
        logger.error(err);
        res
          .status(500)
          .json({ success: false, message: (err as Error).message });
      }
    }),
  );

  router.all("/boom", () => {
    throw new Error("Boom!");
  });

  router.all(
    "/async-boom",
    asyncHandler(async () => {
      throw new Error("Async Boom!");
    }),
  );
}

interface MultipartMetadata {
  uniqueID: string;
}

export class PayloadTooLargeError extends Error {
  constructor() {
    super(`File exceeds the maximum size of ${MAX_UPLOAD_BYTES} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

export function getMultipartData(
  req: Request,
): Promise<[metadata: MultipartMetadata, data: Buffer]> {
  return new Promise((resolve, reject) => {
    let metadata: MultipartMetadata;
    let data: Buffer;
    let tooLarge = false;

    // Parts are consumed asynchronously; busboy's close fires before they settle.
    const parts: Promise<void>[] = [];

    try {
      const body = busboy({
        headers: req.headers,
        limits: { fileSize: MAX_UPLOAD_BYTES },
      });
      body.on("file", (name, file) => {
        logger.trace("Received file field: %s", name);
        if (name === "metadataInput") {
          parts.push(
            text(file).then((value) => {
              metadata = JSON.parse(value);
            }),
          );
        } else if (name === "file") {
          file.on("limit", () => {
            tooLarge = true;
          });
          parts.push(
            buffer(file).then((value) => {
              data = value;
            }),
          );
        } else {
          file.resume();
          return reject(new Error(`Unknown field [${name}]`));
        }
      });

      // If metadataInput does not have a filename, it may come as a field
      body.on("field", (name, val) => {
        if (name === "metadataInput") {
          metadata = JSON.parse(val);
        } else {
          return reject(new Error(`Unknown Field [${name}]`));
        }
      });

      body.on("close", () => {
        Promise.all(parts).then(() => {
          if (tooLarge) return reject(new PayloadTooLargeError());
          if (!metadata) return reject(new Error("Missing [metadataInput]"));
          if (!data) return reject(new Error("Missing [file]"));
          logger.trace("Received both metadata and data, resolving...");
          resolve([metadata, data]);
        }, reject);
      });

      // Malformed multipart or a client disconnect would otherwise leave the
      // promise unsettled and the request hanging.
      body.on("error", reject);
      req.on("error", reject);

      req.pipe(body);
    } catch (error) {
      reject(error);
    }
  });
}

export function verifyIdentity(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  logger.trace("Verifying identity for request to %s", req.path);
  // Get token from the Authorization header (e.g., "Bearer <token>")
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    logger.warn("No token provided");
    return res
      .status(401)
      .json({ success: false, message: "No token provided" });
  }

  // Verify the token
  jwt.verify(token, BATHY_JWT_SECRET, (err, decoded) => {
    if (err) {
      logger.warn({ message: "Invalid token: %s", err });
      return res.status(403).json({ success: false, message: "Invalid token" });
    }
    // If verification is successful, attach the decoded payload to the request
    if (typeof decoded === "object" && "uuid" in decoded) {
      logger.debug("Token verified for uuid: %s", decoded.uuid);
      res.locals.uuid = decoded.uuid;
    }
    next(); // Proceed to the next middleware or route handler
  });
}

export function verifyClientVersion(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  logger.trace("Verifying client version for request to %s", req.path);
  const ua = req.headers["user-agent"];

  // Expect format: crowd-depth/<version> (...)
  const [, clientVersion] = ua?.match(/^crowd-depth\/([^\s]+)(\s|$)/) || [];
  if (!semver.valid(clientVersion)) {
    logger.warn("Missing or invalid User-Agent: %s", ua);
    return res
      .status(400)
      .json({ success: false, message: "Missing or invalid User-Agent" });
  }

  if (semver.lt(clientVersion, MIN_CLIENT_VERSION)) {
    logger.warn(
      "Client version %s below minimum %s",
      clientVersion,
      MIN_CLIENT_VERSION,
    );
    return res.status(426).json({
      success: false,
      message: "Client version too old",
      minVersion: MIN_CLIENT_VERSION,
    });
  }

  next();
}

export function createIdentity(uuid = uuidv4()) {
  logger.debug("Creating identity for uuid: %s", uuid);
  return {
    uuid,
    token: jwt.sign({ uuid }, BATHY_JWT_SECRET),
  };
}
