import { AtpAgent } from "@atproto/api";
import { APPVIEW, USER_AGENT } from "../config.ts";
import type { SearchPostView } from "./types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pages are capped so a runaway query can't paginate through the whole network. */
const MAX_PAGES = 12;
const MAX_ATTEMPTS = 5;
/**
 * Ceiling on a single backoff. bsky.social rate-limit windows run to five
 * minutes, so the previous 60s cap could burn the whole attempt budget while the
 * limit was still in force.
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

export type Searcher = (q: string, opts?: SearchOptions) => Promise<SearchPostView[]>;

/** The hard single-page cap on unauthenticated search, not a transient failure. */
class PaginationCapped extends Error {}

class HttpError extends Error {
  constructor(readonly status: number, readonly resetAt?: number) {
    super(`HTTP ${status}`);
  }
}

/** Both transports surface a status: fetch via HttpError, the agent via XRPCError. */
function statusOf(err: unknown): number | undefined {
  if (err instanceof HttpError) return err.status;
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

function resetAtOf(err: unknown): number | undefined {
  if (err instanceof HttpError) return err.resetAt;
  const headers = (err as { headers?: Record<string, string> })?.headers;
  const reset = Number(headers?.["ratelimit-reset"]);
  return Number.isFinite(reset) && reset > 0 ? reset : undefined;
}

/**
 * Retry/backoff shared by both transports. Previously only the anonymous path had
 * it, which left CI — the authenticated path — with no rate-limit handling at all.
 *
 * A 403 on a cursor request is the unauthenticated single-page cap and is
 * permanent: api.bsky.app refuses it even with a fresh cursor after a delay. It is
 * surfaced immediately rather than burning the full backoff schedule on a request
 * that cannot succeed. A 403 on a first page, by contrast, has been observed to
 * clear on retry, so it stays retryable there.
 *
 * That reasoning is specific to the anonymous transport, so `cursorCapApplies`
 * is false when authenticated: a 403 from the PDS means a revoked app password
 * or a blocked account, and must surface as an error rather than be mistaken for
 * the expected cap.
 */
async function withRetry<T>(
  cursorCapApplies: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  let delay = 1_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);
      if (status === 403 && cursorCapApplies) throw new PaginationCapped();

      // A connection-level failure carries no usable HTTP status: fetch rejects
      // with a TypeError, and XRPCError.from falls back to ResponseType.Unknown
      // (1) or InvalidResponse (2). That is the most common transient failure
      // class, so it retries like a 5xx rather than aborting the run on the
      // first attempt. (Unlisted 5xx codes are safe: httpResponseCodeToEnum maps
      // them to InternalServerError.)
      const retryable = status === undefined
        || status < 100
        || status === 429 || status === 403 || status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;

      // Floored at the exponential delay rather than used in place of it: a
      // ratelimit-reset already in the past (clock skew, a stale or echoed
      // header) computed a zero-length wait, and since resetAt stayed truthy the
      // `delay` accumulator was never consulted — so every remaining attempt
      // fired back to back with no backoff, deepening the limit it was meant to
      // wait out.
      const resetAt = resetAtOf(err);
      const untilReset = resetAt ? resetAt * 1000 - Date.now() : 0;
      const waitMs = Math.min(Math.max(untilReset, delay), MAX_BACKOFF_MS);
      console.warn(`  ${status}; retrying in ${Math.round(waitMs / 1000)}s (${attempt}/${MAX_ATTEMPTS})`);
      await sleep(waitMs);
      delay *= 2;
    }
  }
}

async function fetchPage(url: string): Promise<SearchResponse> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (res.ok) return (await res.json()) as SearchResponse;
  const reset = Number(res.headers.get("ratelimit-reset"));
  throw new HttpError(res.status, Number.isFinite(reset) ? reset : undefined);
}

/**
 * Paginate a query. A refusal mid-pagination keeps the pages already collected
 * rather than failing the run — one capped query must not abort collection.
 */
async function paginate(
  q: string,
  getPage: (cursor?: string) => Promise<SearchResponse>,
  { anonymous }: { anonymous: boolean },
): Promise<SearchPostView[]> {
  const out: SearchPostView[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    let data: SearchResponse;
    try {
      data = await withRetry(anonymous && page > 0, () => getPage(cursor));
    } catch (err) {
      if (err instanceof PaginationCapped && page > 0) {
        console.warn(`  pagination capped after ${page} page(s) for ${q}`);
        break;
      }
      throw err;
    }

    const posts = data.posts ?? [];
    out.push(...posts);
    cursor = data.cursor;
    if (!cursor || posts.length === 0) break;

    // Exiting with a live cursor means results were dropped; say so rather than
    // letting a partial sweep look complete.
    if (page === MAX_PAGES - 1) {
      console.warn(
        `  stopped at the ${MAX_PAGES}-page limit for ${q} with more results available; ` +
        `narrow the query or raise MAX_PAGES`,
      );
    }
    await sleep(500);
  }

  return out;
}

/** Anonymous searcher. Works, but capped at one page per query. */
function publicSearcher(): Searcher {
  return (q, opts = {}) =>
    paginate(q, (cursor) => {
      const params = new URLSearchParams({ q, limit: "100", sort: "latest" });
      if (opts.since) params.set("since", opts.since);
      if (cursor) params.set("cursor", cursor);
      return fetchPage(`${APPVIEW}/xrpc/app.bsky.feed.searchPosts?${params}`);
    }, { anonymous: true });
}

/** Authenticated searcher, proxied through the PDS. */
function authedSearcher(agent: AtpAgent): Searcher {
  return (q, opts = {}) =>
    paginate(q, async (cursor) => {
      const res = await agent.app.bsky.feed.searchPosts({
        q, limit: 100, sort: "latest", ...(opts.since ? { since: opts.since } : {}), cursor,
      });
      return res.data as unknown as SearchResponse;
    }, { anonymous: false });
}

/**
 * Authenticates when BSKY_IDENTIFIER/BSKY_APP_PASSWORD are set, falling back to
 * anonymous access so the collector keeps working if the credential lapses.
 */
export async function createSearcher(): Promise<Searcher> {
  const identifier = process.env.BSKY_IDENTIFIER;
  const password = process.env.BSKY_APP_PASSWORD;

  if (!identifier || !password) {
    console.log("searching anonymously (single page per query)");
    return publicSearcher();
  }

  const agent = new AtpAgent({ service: process.env.BSKY_SERVICE ?? "https://bsky.social" });
  await agent.login({ identifier, password });
  console.log(`searching as ${identifier}`);
  return authedSearcher(agent);
}
