import { execSync } from "node:child_process";

type PreviewKVNamespace = {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string, options?: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: () => Promise<{ keys: unknown[]; list_complete: boolean }>;
  getWithMetadata: (key: string) => Promise<{ value: string | null; metadata: unknown; cacheStatus: unknown }>;
};

type IngestedItem = {
  id: string;
  source_type: "task" | "document" | "email" | "note" | "calendar";
  title: string;
  summary_input: string;
  metadata_json: string;
  created_at: string;
};

const D1_DB_NAME = "daily_brief";
const KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID ?? "aff13c4ce8b049fc8869a526fb392c85";

export function d1Query<T>(sql: string): T[] {
  const escaped = sql.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const raw = execSync(
    `npx wrangler d1 execute "${D1_DB_NAME}" --remote --json --command="${escaped}"`,
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

export function kvGet(key: string): string | null {
  try {
    const result = execSync(
      `npx wrangler kv key get "${key}" --namespace-id="${KV_NAMESPACE_ID}" --remote --text`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

export function makeNullKV(): PreviewKVNamespace {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
}

export type { IngestedItem, PreviewKVNamespace };
