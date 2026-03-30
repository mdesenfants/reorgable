/**
 * External API fetching helpers extracted from preview-live.ts
 */

export type NewsHeadline = {
  title: string;
  source?: string;
  publishedAt?: string;
};

export async function fetchTopHeadlines(apiKey?: string): Promise<NewsHeadline[]> {
  if (!apiKey) return [];
  try {
    const res = await fetch("https://newsapi.org/v2/top-headlines?country=us&pageSize=5", {
      headers: { "X-Api-Key": apiKey },
    });
    if (!res.ok) return [];
    const body = await res.json() as {
      articles?: Array<{ title?: string; source?: { name?: string }; publishedAt?: string }>;
    };
    return (body.articles ?? [])
      .map((a) => ({ title: a.title ?? "", source: a.source?.name, publishedAt: a.publishedAt }))
      .filter((a) => a.title.trim().length > 0)
      .slice(0, 5);
  } catch {
    return [];
  }
}
