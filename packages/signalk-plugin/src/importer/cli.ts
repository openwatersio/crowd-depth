#!/usr/bin/env node

import { formatSummary, parseArgs, runImport } from "./index.js";

try {
  const options = parseArgs(process.argv.slice(2));
  const { summary, submission } = await runImport(options);
  console.log(formatSummary(summary));
  if (options.out) console.log(`GeoJSON written: ${options.out}`);
  if (submission) console.log(`Upload complete: ${submission.message}`);
  else console.log("Preview only; no data uploaded. Pass --upload to upload.");
} catch (error) {
  console.error(`crowd-depth-import: ${(error as Error).message}`);
  process.exitCode = 1;
}
