# DTW Time Zone — Bluesky Feed

> **Historical.** This is the original MVP build plan, kept for the reasoning behind
> the design. It describes the feed as it was first built and is no longer an
> accurate description of the system — most notably, `getFeedSkeleton` is now a
> Cloud Function rather than a static file (issue #2). `README.md` and `CLAUDE.md`
> are current; open work lives in GitHub issues.

A Bluesky custom feed collecting posts of the phrase **"Detroit, Michigan is in the
Eastern Time Zone"** — the recorded announcement that used to play at DTW, and a
long-running inside joke among friends landing there.

## Background

A Bluesky custom feed is not a file format. It's an HTTP service exposing three
endpoints, all of which can be **static JSON**:

| Path | Purpose |
|---|---|
| `/.well-known/did.json` | `did:web` document identifying the generator |
| `/xrpc/app.bsky.feed.describeFeedGenerator` | Lists offered feeds |
| `/xrpc/app.bsky.feed.getFeedSkeleton` | Returns `{feed: [{post: "at://..."}]}` |

The skeleton returns only AT-URIs; Bluesky's AppView hydrates post content at read
time. There is no per-user logic, so a generated static file is a complete
implementation. A one-time `app.bsky.feed.generator` record published to a Bluesky
repo makes the feed discoverable.

## Findings from reconnaissance (2026-08-22)

- **71 exact-phrase posts** exist, dating to **2023-05-01**. By year:
  2023: 13 · 2024: 9 · 2025: 42 · 2026: 25 YTD. Roughly 25 distinct authors.
- Search indexes the full history, so a **one-time backfill captures everything**.
- `app.bsky.feed.searchPosts` returns **403 on `public.api.bsky.app`** (blocked at
  the CDN). It answered unauthenticated on `api.bsky.app` but only for a single
  page, and later refused first pages too. **Collection therefore authenticates**;
  measured, anonymous returned nothing where authenticated returned all 170 results
  across 2 pages.
- Search **ignores punctuation** — comma and no-comma queries return identical sets.
- Loose matching produces convincing false positives ("most of Indiana is in the
  eastern time zone") — hence the review gate below.
- `getFeedSkeleton` caps request `limit` at 100 but sets **no max on the response
  array**.
- A DID document's `serviceEndpoint` may point at a **different host** than the DID
  itself (live precedent: `did:web:skyfeed.me` → `https://feeds.skyfeed.eu`).

## Architecture

```
GitHub Action (cron)
  └─ collect  → query api.bsky.app/searchPosts, paginate, dedupe
  └─ classify → exact match → data/posts.json      (auto-admitted)
                variant     → data/pending.json    (opens a review issue)
  └─ build    → render static artifacts into public/
  └─ deploy   → firebase deploy --only hosting --project dtw-time-zone
```

**Identity:** `did:web:dtw.dimcheff.wtf`, served from Firebase Hosting.
Because the DID's `serviceEndpoint` is indirect, the serving layer can move later
without changing the feed's identity or dropping subscribers.

**Precision model:** exact-phrase matches are ~100% precise and are admitted
automatically. Variants are written to a pending file and require a merged PR to
enter the feed. Nothing ambiguous reaches the feed unreviewed.

## Known constraint: the feed renders one page — *resolved*

Static hosting cannot read the `cursor` query parameter, so the skeleton was a
single page with no cursor. The AppView's `getFeed` slices the skeleton to the
client's requested `limit` and treats a returned cursor equal to the request's —
including absent on a first call — as end-of-feed. Subscribers therefore saw **the
newest `limit` posts, typically 30-50**, regardless of how many entries were served.

Resolved in [#2](https://github.com/bdimcheff/dtw-time-zone/issues/2): the skeleton
is now a Cloud Function behind a Hosting rewrite, paginating on a cursor that
encodes a position in the feed's sort order. The feed's identity was untouched — the
DID document and `describeFeedGenerator` are still the same static files on the same
host.

## Build sequence

1. **Repo** — `git init -b main`; work on `bad/dtw-feed-mvp`. TypeScript + Node,
   no framework.
2. **`src/collect.ts`** — paginated `searchPosts` with backoff; merges into
   `data/posts.json` keyed by AT-URI. Every query is swept in full each run.
3. **`src/lib/match.ts`** — normalizes text (case, accents, punctuation,
   whitespace) and applies the exact matcher; anything looser routes to
   `data/pending.json`.
4. **`src/build.ts`** — emits `public/.well-known/did.json`,
   `public/xrpc/app.bsky.feed.describeFeedGenerator`, and
   `public/xrpc/app.bsky.feed.getFeedSkeleton` (newest 100, no cursor).
   *(Since #2: the skeleton is a function, and `build.ts` emits
   `functions/entries.json` instead.)*
5. **`firebase.json`** — `headers` forcing `Content-Type: application/json` on
   `/xrpc/**` and `/.well-known/did.json`. *(Since #2: narrowed to the one static
   xrpc path, since header rules override a rewritten function's own headers.)* Hosting lives in its own
   `dtw-time-zone` Firebase project, so no hosting target is needed.
   The default `ignore` glob `**/.*` excludes `.well-known` and is replaced with an
   explicit exclusion list, or the DID document silently 404s.
6. **`src/publish-record.ts`** — one-time script writing the
   `app.bsky.feed.generator` record to **`dimcheff.wtf`**, which becomes the feed's
   listed creator.
7. **`.github/workflows/update.yml`** — cron; typechecks and tests, then runs
   collect → build, commits the data files, deploys, and opens (or comments on) a
   review issue when `pending.json` grows.
8. **Verification** — confirm `Content-Type` on the deployed endpoints, resolve the
   DID, and subscribe to the feed in the Bluesky app.

## Manual steps required

- DNS records for `dtw.dimcheff.wtf` (Firebase provides them on site creation).
- Firebase Hosting site `dtw` added to the existing `bdimcheff` project.
- GitHub secrets: `FIREBASE_SERVICE_ACCOUNT`, and `BSKY_APP_PASSWORD` for the
  one-time record publish.
- GitHub disables scheduled workflows after 60 days without repository activity;
  re-enable manually when it happens.

## Deferred (not MVP)

- **Riff detection** — capture plays on the original form from known DTW posters,
  e.g. "Jackson Hole, Wyoming is in the Mountain Time Zone". Needs an author
  allowlist plus a generalized `<place> is in the <X> Time Zone` matcher, and its
  own review gate. Deliberately out of scope until the base feed is running.
- **Archive web page** — HTML listing every captured post, browsable outside a
  Bluesky client.
- **Stats / leaderboard** — posts per year, top posters, first sighting.
- **RSS/JSON syndication.**
