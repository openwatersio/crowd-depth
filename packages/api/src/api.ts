import { Router } from "express";
import type { IRouter, NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import busboy from "busboy";
import { text } from "stream/consumers";
import { submitFormData } from "crowd-depth";
import { Readable } from "stream";
import { createReadStream, createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createS3Storage, S3Config } from "./s3.js";
import { pipeline } from "stream/promises";
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

export type APIOptions = {
  url?: string;
  token?: string;
  env?: Record<string, string>;
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

  const storage = createS3Storage(env as S3Config);

  router.get("/", (req, res) => {
    res.json({ success: true, message: "API is reachable" });
  });

  router.post("/identify", (req, res) => {
    res.json(createIdentity());
  });

  /**
   * API to proxy requests to NOAA CSB XYZ upload endpoint, with authentication.
   *
   * @see https://www.ncei.noaa.gov/sites/g/files/anmtlf171/files/2024-04/GuidanceforSubmittingCSBDataToTheIHODCDB%20%281%29.pdf
   */
  router.post(
    "/geojson",
    verifyIdentity,
    asyncHandler(async (req, res) => {
      let metadata: MultipartMetadata;
      let data: Readable;

      try {
        [metadata, data] = await getMultipartData(req);
      } catch (error) {
        logger.error(error);
        res
          .status(400)
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

      // Save data to a temporary file first
      const tempFile = join(
        tmpdir(),
        `${uuid}-${Date.now().toString(36)}.geojson`,
      );

      try {
        // Pipe the data to a temp file
        await pipeline(data, createWriteStream(tempFile));

        // Stream from the temp file to both NOAA and S3
        const [submission] = await Promise.all([
          submitFormData(
            new URL("geojson", url),
            uuid,
            metadata,
            createReadStream(tempFile),
            {
              "x-auth-token": token,
            },
          ),
          storage?.store(uuid, tempFile),
        ]);

        res.json(submission);
      } catch (err) {
        logger.error(err);
        res
          .status(500)
          .json({ success: false, message: (err as Error).message });
      } finally {
        // Clean up the temporary file
        await unlink(tempFile).catch(() => {
          /* Ignore cleanup errors */
        });
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

export function getMultipartData(
  req: Request,
): Promise<[metadata: MultipartMetadata, data: Readable]> {
  return new Promise((resolve, reject) => {
    let metadata: MultipartMetadata;
    let data: Readable;

    // Resolve the promise when both metadata and data are received. The caller will read data from the stream.
    function resolveIfReady() {
      if (metadata && data) {
        logger.trace("Received both metadata and data, resolving...");
        resolve([metadata, data]);
      }
    }

    try {
      const body = busboy({ headers: req.headers });
      body.on("file", async (name, file) => {
        logger.trace("Received file field: %s", name);
        if (name === "metadataInput") {
          metadata = JSON.parse(await text(file));
        } else if (name === "file") {
          data = file;
        } else {
          return reject(new Error(`Unknown field [${name}]`));
        }

        resolveIfReady();
      });

      // If metadataInput does not have a filename, it may come as a field
      body.on("field", (name, val) => {
        if (name === "metadataInput") {
          metadata = JSON.parse(val);
        } else {
          return reject(new Error(`Unknown Field [${name}]`));
        }

        resolveIfReady();
      });

      body.on("close", () => {
        if (!metadata) return reject(new Error("Missing [metadataInput]"));
        if (!data) return reject(new Error("Missing [file]"));
      });

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

export function createIdentity(uuid = uuidv4()) {
  logger.debug("Creating identity for uuid: %s", uuid);
  return {
    uuid,
    token: jwt.sign({ uuid }, BATHY_JWT_SECRET),
  };
}
