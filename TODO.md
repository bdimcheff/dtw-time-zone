# TODO

Follow-up work, roughly in priority order. The MVP ships static; these are the
things deliberately left out of it.

---

## 1. Real pagination via Firebase Functions

**Status:** planned. This is the only item that limits the feed's core function.

### Why

The feed currently serves a single static page with no cursor. Two lines in the
AppView (`packages/bsky/src/api/app/bsky/feed/getFeed.ts`) decide what a subscriber
actually sees:

```ts
const feedItems = feedSkele.slice(0, params.limit).map(...)
// ...
cursor: feedSkele.length === 0 || cursor === params.cursor ? undefined : cursor,
```

The first truncates our skeleton to the client's requested `limit`. The second
treats the feed as ended when the returned cursor matches the request's — which,
for a response with no cursor at all, is true on the very first call.

So the feed renders **the newest `limit` posts and stops**. Measured against the
live feed with `app.bsky.feed.getFeed`:

| Requested `limit` | Posts returned | Cursor returned |
|---:|---:|:---|
| *(none, defaults to 50)* | 50 | no |
| 10 | 10 | no |
| 30 | 30 | no |
| 50 | 50 | no |
| 100 | 85 (all we have) | no |

The window is exactly the client's `limit`, and no request ever yields a cursor, so
page two is unreachable. The Bluesky app requests 30. With 85 posts archived, 55 are
already unreachable by subscribers — the constraint is binding today, not eventually.

### Design

Keep `data/posts.json` as the source of truth and the Action as the collector.
Replace only the skeleton endpoint.

- Firebase Hosting rewrite: `/xrpc/app.bsky.feed.getFeedSkeleton` → a callable
  function. `.well-known/did.json` and `describeFeedGenerator` stay static, so the
  feed's identity is untouched and no subscriber is affected.
- The function reads the post list bundled at deploy time (no database — the data
  changes only when the Action deploys).
- Honour `limit` (1-100, default 50) and `cursor`.
- Cursor should encode the sort key of the last item returned, not an offset, so
  that posts added between pages don't cause skips or repeats. `sortAt` +
  URI as a tiebreaker is enough; see `src/lib/store.ts`.
- Return no cursor on the final page. Never echo the request's cursor back — the
  AppView reads that as end-of-feed.

### Prerequisites

- Upgrade the `dtw-time-zone` project to the **Blaze** plan. Cost at any plausible
  traffic level is **$0**: the free tier covers 2M invocations and 5 GB egress per
  month, and a 50-entry page is ~4 KB. Paying anything at all requires roughly
  67,000 requests/day.
- Set a Cloud Billing **budget alert** (~$5) and a **`max-instances` cap** on the
  function. The risk here is a scrape or a loop, not organic traffic, and these
  bound the damage.

### Verification

- `npm run verify` should gain a pagination check: request `limit=10`, follow the
  cursor, and assert no post is skipped or repeated across pages.
- Confirm end-to-end with `app.bsky.feed.getFeed` against the live feed and count
  what a real client receives — the AppView, not our endpoint, is the authority on
  what subscribers see.

### Then

Once pagination works, `FEED_LIMIT` in `src/config.ts` can be removed and the
truncation warning in `src/build.ts` deleted.

---

## 2. Riff detection

Capture plays on the original form — *"Jackson Hole, Wyoming is in the Mountain Time
Zone"*. Several are already in the feed by hand (Orlando, Kalamazoo), admitted
during the first review.

Needs a generalized `<place> is in the <X> Time Zone` matcher, which will match a
great deal of sincere geography, so it needs both an **author allowlist** (people
known to be in on the joke) and its own review gate. `data/denied.json` deliberately
does not contain the riffs rejected in round one, so they remain available to this
feature.

## 3. Archive page

A static HTML page listing every captured post with author, date, and link. This is
what makes the full archive reachable regardless of what the feed can render — worth
doing whether or not pagination lands.

## 4. Stats

Posts per year, top posters, first sighting. All derivable from `data/posts.json`.
The 2009-dated post is a Twitter import and will skew any naive "first sighting"
calculation — use `sortAt`, not `createdAt`.

## 5. Housekeeping

- Two entries sit in `data/pending.json` awaiting a call (`danielmwarwick`
  2026-05-10, `drmikewiser` 2025-11-30).
- No tests. The matcher is the part worth covering; it has a real corpus to test
  against in `data/`.
