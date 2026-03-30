type EngagementSummary = {
  briefName: string;
  uploadedAt: string;
  stillOnDevice: boolean;
  deletedAt?: string;
  lastSeenAt?: string;
  retentionHours?: number;
};

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

export const FOLDERS = { CURRENT_BRIEFS_FOLDER };
export type { EngagementSummary };
