/**
 * D1 and KV data retrieval helpers extracted from preview-live.ts
 */

import type { IngestedItem } from "../workers/report-worker/src/fetchers";

export interface EngagementSummary {
  briefName: string;
  uploadedAt: string;
  stillOnDevice: boolean;
  deletedAt?: string;
  lastSeenAt?: string;
  retentionHours?: number;
}

export function getPreviousOverview(d1Query: <T>(sql: string) => T[]): string | undefined {
  const rows = d1Query<{ summary_json: string }>("SELECT summary_json FROM report_runs ORDER BY run_at DESC LIMIT 1");
  if (!rows[0]?.summary_json) return undefined;
  try {
    return (JSON.parse(rows[0].summary_json) as { overview?: string }).overview || undefined;
  } catch {
    return undefined;
  }
}

export function getPreviousEngagement(d1Query: <T>(sql: string) => T[]): EngagementSummary | undefined {
  const rows = d1Query<{ remarkable_doc_name: string; uploaded_at: string; last_seen_at: string | null; deleted_at: string | null }>(
    "SELECT remarkable_doc_name, uploaded_at, last_seen_at, deleted_at FROM brief_engagement ORDER BY uploaded_at DESC LIMIT 1"
  );
  const row = rows[0];
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
    retentionHours: retentionMs > 0 ? Math.round((retentionMs / 3_600_000) * 10) / 10 : undefined,
  };
}
