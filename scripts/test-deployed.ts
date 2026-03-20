/**
 * Smoke-tests the deployed report worker.
 *
 * Usage:
 *   WORKER_URL=https://… npm run test:deployed
 *
 * WORKER_URL is required — set it to your deployed report worker URL.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 */

const BASE_URL = process.env.WORKER_URL;
if (!BASE_URL) {
  console.error("Set WORKER_URL to your deployed report worker, e.g. https://reorgable-report.<your-subdomain>.workers.dev");
  process.exit(1);
}

type CheckResult = { name: string; ok: boolean; detail?: string };

async function check(
  name: string,
  fn: () => Promise<string | void>
): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, ok: true, detail: detail ?? undefined };
  } catch (err) {
    return {
      name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  console.log(`\nTesting worker at ${BASE_URL}\n`);

  const results: CheckResult[] = [];

  // ── 1. Health check ──────────────────────────────────────────────────────
  results.push(
    await check("GET /health → 200 ok:true", async () => {
      const res = await fetch(`${BASE_URL}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { ok?: boolean };
      if (body.ok !== true) throw new Error(`ok was ${body.ok}`);
    })
  );

  // ── 2. Unknown route returns 404 ─────────────────────────────────────────
  results.push(
    await check("GET /unknown → 404 JSON error", async () => {
      const res = await fetch(`${BASE_URL}/unknown`);
      if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
      const body = (await res.json()) as { error?: string };
      if (!body.error) throw new Error("No error field in body");
    })
  );

  // ── 3. POST /run without force=true → skipped (not 5 AM) ─────────────────
  results.push(
    await check("POST /run (no force) → skipped or ok", async () => {
      const res = await fetch(`${BASE_URL}/run`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { ok?: boolean };
      if (body.ok !== true) throw new Error(`ok was ${body.ok}`);
    })
  );

  // ── 4. POST /run?force=true → full report run ─────────────────────────────
  results.push(
    await check("POST /run?force=true → ok:true, not skipped", async () => {
      const res = await fetch(`${BASE_URL}/run?force=true`, { method: "POST" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const body = (await res.json()) as {
        ok?: boolean;
        skipped?: boolean;
        error?: string;
        sourceCount?: number;
        reportKey?: string;
      };
      if (body.error) throw new Error(body.error);
      if (body.ok !== true) throw new Error(`ok was ${body.ok}`);
      if (body.skipped === true) throw new Error("Report was skipped (force had no effect?)");
      return `sourceCount=${body.sourceCount ?? "?"}, reportKey=${body.reportKey ?? "?"}`;
    })
  );

  // ── Print results ─────────────────────────────────────────────────────────
  let failures = 0;
  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    const detail = r.detail ? `  (${r.detail})` : "";
    console.log(`  ${icon} ${r.name}${detail}`);
    if (!r.ok) failures++;
  }

  console.log(
    `\n${results.length - failures}/${results.length} checks passed.\n`
  );

  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
