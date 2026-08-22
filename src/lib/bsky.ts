import { AtpAgent } from "@atproto/api";
import type { SearchPostView } from "./types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pages are capped so a runaway query can't paginate through the whole network. */
const MAX_PAGES = 12;
const MAX_ATTEMPTS = 5;
/**
 * Ceiling on a single backoff. bsky.social rate-limit windows run to five
 * minutes, so a shorter cap could burn the whole attempt budget while the limit
 * was still in force.
 */
const MAX_BACKOFF_MS = 300_000;

interface SearchResponse {
  posts?: SearchPostView[];
  cursor?: string;
}

export interface SearchOptions {
  /** ISO timestamp. Filters on `sortAt`, which may lag `createdAt` — see PLAN.md. */
  since?: string;
}

export interface SearchResult {
  posts: SearchPostView[];
  /**
   * Pagination stopped at MAX_PAGES with results still available. The caller
   * needs this: results inside the requested window were never examined, so its
   * `since` watermark must not move past them.
   */
  truncated: boolean;
}

export type Searcher = (q: string, opts?: SearchOptions) => Promise<SearchResult>;

/** XRPCError carries a numeric status; a connection failure carries none. */
const statusOf = (err: unknown): number | undefined => {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
};

function resetAtOf(err: unknown): number | undefined {
  const headers = (err as { headers?: Record<string, string> })?.headers;
  const reset = Number(headers?.["ratelimit-reset"]);
  return Number.isFinite(reset) && reset > 0 ? reset : undefined;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let delay = 1_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);

      // A connection-level failure carries no usable status: XRPCError.from falls
      // back to ResponseType.Unknown (1) or InvalidResponse (2). That is the most
      // common transient failure class, so it retries like a 5xx rather than
      // aborting the run on the first attempt.
      const retryable = status === undefined || status < 100 || status === 429 || status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;

      // Floored at the exponential delay rather than used in place of it: a
      // ratelimit-reset already in the past (clock skew, a stale header) yields a
      // zero-length wait, which would fire every remaining attempt back to back
      // and deepen the limit it was meant to wait out.
      const resetAt = resetAtOf(err);
      const untilReset = resetAt ? resetAt * 1000 - Date.now() : 0;
      const waitMs = Math.min(Math.max(untilReset, delay), MAX_BACKOFF_MS);
      console.warn(`  ${status ?? "network error"}; retrying in ${Math.round(waitMs / 1000)}s (${attempt}/${MAX_ATTEMPTS})`);
      await sleep(waitMs);
      delay *= 2;
    }
  }
}

/**
 * Search all pages for a query, newest first.
 *
 * Authentication is required, not merely preferred: anonymous searchPosts on
 * api.bsky.app refuses every cursor request with "403 Request forbidden by
 * administrative rules", and has been observed refusing first pages too.
 * Measured against the same query, anonymous returned nothing while
 * authenticated returned all 170 results across 2 pages.
 */
function searcher(agent: AtpAgent): Searcher {
  return async (q, { since }: SearchOptions = {}) => {
    const posts: SearchPostView[] = [];
    let cursor: string | undefined;
    let truncated = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await withRetry(() =>
        agent.app.bsky.feed.searchPosts({
          q, limit: 100, sort: "latest", ...(since ? { since } : {}), cursor,
        }),
      );
      const data = res.data as unknown as SearchResponse;
      const found = data.posts ?? [];
      posts.push(...found);

      cursor = data.cursor;
      if (!cursor || found.length === 0) break;

      // Exiting with a live cursor means results were dropped; say so rather than
      // letting a partial sweep look complete.
      if (page === MAX_PAGES - 1) {
        console.warn(
          `  stopped at the ${MAX_PAGES}-page limit for ${q} with more results available; ` +
          `narrow the query or raise MAX_PAGES`,
        );
        truncated = true;
      }
      await sleep(500);
    }

    return { posts, truncated };
  };
}

export async function createSearcher(): Promise<Searcher> {
  const identifier = process.env.BSKY_IDENTIFIER;
  const password = process.env.BSKY_APP_PASSWORD;
  if (!identifier || !password) {
    // A missing secret is operator configuration, not a crash: exit cleanly
    // rather than printing a stack trace that buries the instruction.
    console.error(
      "BSKY_IDENTIFIER and BSKY_APP_PASSWORD are required: anonymous search is\n" +
      "refused by api.bsky.app. Create an app password at Settings -> App Passwords.",
    );
    process.exit(1);
  }

  const agent = new AtpAgent({ service: process.env.BSKY_SERVICE ?? "https://bsky.social" });
  try {
    await agent.login({ identifier, password });
  } catch (err) {
    throw new Error(
      `login failed for ${identifier}: ${(err as Error).message}. ` +
      "Check the BSKY_APP_PASSWORD secret.",
    );
  }
  console.log(`searching as ${identifier}`);
  return searcher(agent);
}
