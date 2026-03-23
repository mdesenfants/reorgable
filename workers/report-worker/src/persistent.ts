import type { DailyOfficeData } from "./daily-office";

type ArchiveResult = {
  attempted: boolean;
  archived: boolean;
  sourceKey?: string;
  message: string;
};

type EngagementSummary = {
  briefName: string;
  uploadedAt: string;
  stillOnDevice: boolean;
  deletedAt?: string;
  lastSeenAt?: string;
  retentionHours?: number;
};

const LAST_ARCHIVED_KEY = "last_archived_report_key";
const HISTORY_BRIEFS_FOLDER = "/Briefs";
const CURRENT_BRIEFS_FOLDER = "/Daily Briefings";

export async function persistRun(
  env: { DB: D1Database },
  runAt: string,
  sourceCount: number,
  summaryJson: string,
  uploadStatus: string,
  uploadMessage: string,
  remarkableDocId?: string
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO report_runs (id, run_at, source_count, summary_json, upload_status, upload_message, remarkable_doc_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  )
    .bind(id, runAt, sourceCount, summaryJson, uploadStatus, uploadMessage, remarkableDocId ?? null)
    .run();
  return id;
}

export async function getPreviousOverview(env: { DB: D1Database }): Promise<string | undefined> {
  const row = await env.DB.prepare(
    `SELECT summary_json FROM report_runs ORDER BY run_at DESC LIMIT 1`
  ).first<{ summary_json: string }>();

  if (!row?.summary_json) return undefined;
  try {
    const parsed = JSON.parse(row.summary_json) as { overview?: string };
    return parsed.overview || undefined;
  } catch {
    return undefined;
  }
}

export async function getPreviousEngagement(env: { DB: D1Database }): Promise<EngagementSummary | undefined> {
  const row = await env.DB.prepare(
    `SELECT remarkable_doc_name, uploaded_at, last_seen_at, deleted_at
     FROM brief_engagement
     ORDER BY uploaded_at DESC LIMIT 1`
  ).first<{ remarkable_doc_name: string; uploaded_at: string; last_seen_at: string | null; deleted_at: string | null }>();

  if (!row) return undefined;

  const stillOnDevice = !row.deleted_at;
  const endTime = row.deleted_at ?? row.last_seen_at ?? row.uploaded_at;
  const retentionMs = new Date(endTime).getTime() - new Date(row.uploaded_at).getTime();

  return {
    briefName: row.remarkable_doc_name,
    uploadedAt: row.uploaded_at,
    stillOnDevice,
    deletedAt: row.deleted_at ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
    retentionHours: retentionMs > 0 ? Math.round(retentionMs / 3_600_000 * 10) / 10 : undefined,
  };
}

export async function archivePreviousBrief(
  env: { STATE_KV: KVNamespace; REPORT_BUCKET: R2Bucket },
  adapter: Record<string, unknown>,
  now: Date,
  currentFileName: string,
  buildFileName: (d: Date) => string,
  uploadWithRetry: (
    adapter: unknown,
    args: { fileName: string; folder: string; bytes: Uint8Array },
    maxAttempts?: number
  ) => Promise<{ ok: boolean; message: string }>
): Promise<ArchiveResult> {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const previousFileName = buildFileName(yesterday);
  const previousKey = `reports/${previousFileName}`;

  if (previousFileName === currentFileName) {
    return {
      attempted: false,
      archived: false,
      sourceKey: previousKey,
      message: "Previous brief filename matched current; skipping archive"
    };
  }

  const alreadyArchived = await env.STATE_KV.get(LAST_ARCHIVED_KEY);
  if (alreadyArchived === previousKey) {
    return {
      attempted: false,
      archived: false,
      sourceKey: previousKey,
      message: "Previous brief already archived"
    };
  }

  const previousObj = await env.REPORT_BUCKET.get(previousKey);
  if (!previousObj) {
    return {
      attempted: false,
      archived: false,
      sourceKey: previousKey,
      message: "No previous brief found in R2 to archive"
    };
  }

  const bytes = new Uint8Array(await previousObj.arrayBuffer());
  const upload = await uploadWithRetry(adapter, {
    fileName: previousFileName,
    folder: HISTORY_BRIEFS_FOLDER,
    bytes
  });

  if (!upload.ok) {
    return {
      attempted: true,
      archived: false,
      sourceKey: previousKey,
      message: `Archive upload failed: ${upload.message}`
    };
  }

  await env.STATE_KV.put(LAST_ARCHIVED_KEY, previousKey);
  return {
    attempted: true,
    archived: true,
    sourceKey: previousKey,
    message: "Archived previous brief to /Briefs"
  };
}

export async function recordEngagementTracking(
  env: { DB: D1Database },
  reportRunId: string,
  remarkableDocId: string,
  fileName: string,
  now: Date
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO brief_engagement (id, report_run_id, remarkable_doc_id, remarkable_doc_name, uploaded_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(crypto.randomUUID(), reportRunId, remarkableDocId, fileName, now.toISOString())
    .run();
}

export async function checkBriefEngagement(env: { DB: D1Database }, remoteDocIds: Set<string>) {
  const { results: tracked } = await env.DB.prepare(
    `SELECT id, remarkable_doc_id FROM brief_engagement WHERE deleted_at IS NULL AND remarkable_doc_id IS NOT NULL`
  ).all<{ id: string; remarkable_doc_id: string }>();

  let updated = 0;
  const now = new Date().toISOString();

  for (const entry of tracked ?? []) {
    if (remoteDocIds.has(entry.remarkable_doc_id)) {
      await env.DB.prepare(
        `UPDATE brief_engagement SET last_seen_at = ?1 WHERE id = ?2`
      ).bind(now, entry.id).run();
      updated++;
    } else {
      await env.DB.prepare(
        `UPDATE brief_engagement SET deleted_at = ?1 WHERE id = ?2`
      ).bind(now, entry.id).run();
      updated++;
    }
  }

  return { checked: tracked?.length ?? 0, updated };
}

export const FOLDERS = { CURRENT_BRIEFS_FOLDER, HISTORY_BRIEFS_FOLDER };
export type { ArchiveResult, EngagementSummary };
