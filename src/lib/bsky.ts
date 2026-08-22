import { AtpAgent } from "@atproto/api";
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

export interface SearchOptions {
  /** ISO timestamp. Filters on `sortAt`, which may lag `createdAt` — see PLAN.md. */
  since?: string;
}

export type Searcher = (q: string, opts?: SearchOptions) => Promise<SearchPostView[]>;

class Forbidden extends Error {}

/**
 * Unauthenticated searchPosts serves exactly one page: api.bsky.app returns
 * "403 Request forbidden by administrative rules" for any cursor request, even
 * with a fresh cursor after a delay. Authenticated calls proxy through the PDS
 * instead, which is expected to lift the cap.
 *
 * The exact-phrase query currently returns 71 results, so it fits in a single
 * page and works unauthenticated — but it will start silently truncating once
 * it crosses 100.
 */
async function fetchPage(url: string): Promise<SearchResponse> {
  let delay = 1_000;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (res.ok) return (await res.json()) as SearchResponse;

    const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      if (res.status === 403) throw new Forbidden("403");
      throw new Error(`searchPosts ${res.status} ${res.statusText}`);
    }

    const reset = Number(res.headers.get("ratelimit-reset"));
    const waitMs = Number.isFinite(reset) && reset > 0
      ? Math.max(0, reset * 1000 - Date.now())
      : delay;
    await sleep(Math.min(waitMs, 60_000));
    delay *= 2;
  }
}

/**
 * Paginate a query. A mid-pagination refusal keeps the pages already collected
 * rather than failing the run — one capped query must not abort collection.
 */
async function paginate(
  q: string,
  { since }: SearchOptions,
  getPage: (cursor?: string) => Promise<SearchResponse>,
): Promise<SearchPostView[]> {
  const out: SearchPostView[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    let data: SearchResponse;
    try {
      data = await getPage(cursor);
    } catch (err) {
      if (err instanceof Forbidden && page > 0) {
        console.warn(`  pagination capped after ${page} page(s) for ${q}`);
        break;
      }
      throw err;
    }

    const posts = data.posts ?? [];
    out.push(...posts);
    cursor = data.cursor;
    if (!cursor || posts.length === 0) break;
    await sleep(500);
  }

  return out;
}

/** Anonymous searcher. Works, but capped at one page per query. */
function publicSearcher(): Searcher {
  return (q, opts = {}) =>
    paginate(q, opts, (cursor) => {
      const params = new URLSearchParams({ q, limit: "100", sort: "latest" });
      if (opts.since) params.set("since", opts.since);
      if (cursor) params.set("cursor", cursor);
      return fetchPage(`${APPVIEW}/xrpc/app.bsky.feed.searchPosts?${params}`);
    });
}

/** Authenticated searcher, proxied through the PDS. */
function authedSearcher(agent: AtpAgent): Searcher {
  return (q, opts = {}) =>
    paginate(q, opts, async (cursor) => {
      const res = await agent.app.bsky.feed.searchPosts({
        q, limit: 100, sort: "latest", ...(opts.since ? { since: opts.since } : {}), cursor,
      });
      return res.data as unknown as SearchResponse;
    });
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
