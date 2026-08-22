import { APPVIEW, USER_AGENT } from "../config.ts";
import type { SearchPostView } from "./types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pages are capped so a runaway query can't paginate through the whole network. */
const MAX_PAGES = 12;
const MAX_ATTEMPTS = 5;

interface SearchResponse {
  posts?: SearchPostView[];
  cursor?: string;
}

/**
 * The AppView rate-limits aggressively — probing tripped it after roughly six
 * paginated queries — and signals it with 429 *or* 403 depending on which layer
 * rejects. Both are retried with exponential backoff, honouring ratelimit-reset
 * when present.
 */
async function getWithRetry(url: string): Promise<SearchResponse> {
  let delay = 1_000;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (res.ok) return (await res.json()) as SearchResponse;

    const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`searchPosts ${res.status} ${res.statusText} for ${url}`);
    }

    const reset = Number(res.headers.get("ratelimit-reset"));
    const waitMs = Number.isFinite(reset) && reset > 0
      ? Math.max(0, reset * 1000 - Date.now())
      : delay;
    console.warn(`  ${res.status}; retrying in ${Math.round(waitMs / 1000)}s (${attempt}/${MAX_ATTEMPTS})`);
    await sleep(Math.min(waitMs, 60_000));
    delay *= 2;
  }
}

export interface SearchOptions {
  /** ISO timestamp. Filters on `sortAt`, which may lag `createdAt` — see PLAN.md. */
  since?: string;
}

/** Search all pages for a query, newest first. */
export async function searchPosts(
  q: string,
  { since }: SearchOptions = {},
): Promise<SearchPostView[]> {
  const out: SearchPostView[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ q, limit: "100", sort: "latest" });
    if (since) params.set("since", since);
    if (cursor) params.set("cursor", cursor);

    const data = await getWithRetry(`${APPVIEW}/xrpc/app.bsky.feed.searchPosts?${params}`);
    const posts = data.posts ?? [];
    out.push(...posts);

    cursor = data.cursor;
    if (!cursor || posts.length === 0) break;
    await sleep(500);
  }

  return out;
}
