/**
 * Smoke-tests note ingestion on the deployed ingest worker.
 *
 * Usage:
 *   INGEST_URL=https://... INGEST_API_TOKEN=... npm run test:ingest:note
 */

const INGEST_URL = process.env.INGEST_URL;
const INGEST_API_TOKEN = process.env.INGEST_API_TOKEN;

function fail(message: string): never {
  throw new Error(message);
}

async function main(): Promise<void> {
  if (!INGEST_URL) fail("Missing INGEST_URL");
  if (!INGEST_API_TOKEN) fail("Missing INGEST_API_TOKEN");

  const health = await fetch(`${INGEST_URL}/health`, {
    headers: { authorization: `Bearer ${INGEST_API_TOKEN}` }
  });
  if (!health.ok) fail(`Health failed: HTTP ${health.status}`);

  const externalId = `note-smoke-${Date.now()}`;
  const payload = {
    title: "Quick capture",
    text: "Remember to book dentist appointment",
    tags: ["personal", "errands"],
    externalId
  };

  const ingest = await fetch(`${INGEST_URL}/ingest/note`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${INGEST_API_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!ingest.ok) {
    fail(`Note ingest failed: HTTP ${ingest.status} ${await ingest.text()}`);
  }

  const body = (await ingest.json()) as {
    id?: string;
    sourceType?: string;
    storedAt?: string;
  };

  if (body.sourceType !== "note") {
    fail(`Unexpected sourceType: ${body.sourceType}`);
  }

  console.log("Note ingestion smoke check passed:");
  console.log(`  id=${body.id ?? "?"}`);
  console.log(`  storedAt=${body.storedAt ?? "?"}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
