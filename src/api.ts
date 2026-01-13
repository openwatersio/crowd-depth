import { Router } from "express";
import type { IRouter, NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import busboy from "busboy";
import { text } from "stream/consumers";
import { Metadata, submitFormData } from "./reporters/noaa.js";
import { Readable } from "stream";
import { createReadStream, createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createS3Storage } from "./storage/s3.js";
import { pipeline } from "stream/promises";

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
};

export function createApi(options: APIOptions = {}): IRouter {
  const router = Router();
  registerWithRouter(router, options);
  return router;
}

export function registerWithRouter(router: IRouter, options: APIOptions = {}) {
  const { url = NOAA_CSB_URL, token = NOAA_CSB_TOKEN } = options;
  const storage = createS3Storage();

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
  router.post("/xyz", verifyIdentity, async (req, res) => {
    let metadata: Metadata;
    let data: Readable;

    try {
      [metadata, data] = await xyzFromRequest(req);
    } catch (error) {
      return res
        .status(400)
        .json({ success: false, message: (error as Error).message });
    }

    // Validate that the uniqueID matches the identity UUID
    const { uuid } = res.locals;
    const uniqueID = metadata?.platform?.uniqueID;
    if (uniqueID !== `SIGNALK-${uuid}`) {
      return res
        .status(403)
        .json({ success: false, message: "Invalid uniqueID" });
    }

    const key = `${uuid}-${new Date().toISOString()}`;

    // Save data to a temporary file first
    const tempFile = join(tmpdir(), `${key}.xyz`);

    try {
      // Pipe the data to a temp file
      await pipeline(data, createWriteStream(tempFile));

      // Stream from the temp file to both NOAA and S3
      const [submission] = await Promise.all([
        submitFormData(
          new URL("xyz", url),
          key,
          metadata,
          createReadStream(tempFile),
          {
            "x-auth-token": token,
          },
        ),
        storage?.store(key, metadata, tempFile),
      ]);

      res.json(submission);
    } finally {
      // Clean up the temporary file
      await unlink(tempFile).catch(() => {
        /* Ignore cleanup errors */
      });
    }
  });
}

export function xyzFromRequest(
  req: Request,
): Promise<[metadata: Metadata, data: Readable]> {
  return new Promise((resolve, reject) => {
    let metadata: Metadata;
    let data: Readable;

    // Resolve the promise when both metadata and data are received. The caller will read data from the stream.
    function resolveIfReady() {
      if (metadata && data) {
        resolve([metadata, data]);
      }
    }

    try {
      const body = busboy({ headers: req.headers });
      body.on("file", async (name, file) => {
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
  // Get token from the Authorization header (e.g., "Bearer <token>")
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res
      .status(401)
      .json({ success: false, message: "No token provided" });
  }

  // Verify the token
  jwt.verify(token, BATHY_JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ success: false, message: "Invalid token" });
    }
    // If verification is successful, attach the decoded payload to the request
    if (typeof decoded === "object" && "uuid" in decoded) {
      res.locals.uuid = decoded.uuid;
    }
    next(); // Proceed to the next middleware or route handler
  });
}

export function createIdentity(uuid = uuidv4()) {
  return {
    uuid,
    token: jwt.sign({ uuid }, BATHY_JWT_SECRET),
  };
}
