import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("viewport acceptance rejects slow, empty and incomplete measurements", () => {
  const dir = mkdtempSync(join(tmpdir(), "viewport-gate-"));
  const file = join(dir, "result.jsonl");
  const script = fileURLToPath(
    new URL("../scripts/check-viewport-benchmark.mjs", import.meta.url),
  );
  const views = Array.from({ length: 15 }, (_, i) => ({
    round: Math.floor(i / 3),
    z: 13 + (i % 3),
    firstVisibleMs: 200,
    coldMs: 700,
    results: Array.from({ length: 9 }, () => ({ ms: 700, bytes: 100 })),
  }));
  const health = {
    health: Array.from({ length: 30 }, () => ({ status: 200, ms: 100 })),
  };
  const check = (rows: unknown[]) => {
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n"));
    return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  };
  try {
    expect(check([...views, health]).status).toBe(0);
    expect(check(views).status).toBe(1);
    expect(check([...views.slice(1), health]).status).toBe(1);
    expect(
      check([{ ...views[0], firstVisibleMs: 501 }, ...views.slice(1), health])
        .status,
    ).toBe(1);
    expect(
      check([
        ...views,
        {
          health: health.health.map((sample, i) =>
            i === 0 ? { ...sample, status: 500 } : sample,
          ),
        },
      ]).status,
    ).toBe(1);
    expect(
      check([
        ...views.map((v) => ({
          ...v,
          results: v.results.map((r) => ({ ...r, bytes: 0 })),
        })),
        health,
      ]).status,
    ).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
