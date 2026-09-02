# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A Bluesky feed collecting posts of the DTW airport announcement "Detroit, Michigan
is in the Eastern Time Zone". Live at
<https://bsky.app/profile/dimcheff.wtf/feed/dtw-time-zone>.

## Commands

| Command | |
|---|---|
| `npm run check` | Typecheck + tests. Run before pushing. |
| `npm run test` | Tests only |
| `npm run collect` | Search Bluesky, update `data/` — **requires credentials** |
| `npm run build` | Render `public/` and `functions/entries.json` from `data/posts.json` |
| `npm run build:functions` | Bundle `src/functions/` into `functions/index.js` |
| `npm run verify` | Smoke-test the deployed endpoints |
| `npm run pending-report` | Render the review queue as markdown |
| `npm run apply-review` | Apply a review session's decisions to `data/` |
| `npm run publish-record` | Publish the feed record (one-time, idempotent) |

Run a single test file: `node --import tsx --test src/lib/match.test.ts`

`collect` needs `BSKY_IDENTIFIER` and `BSKY_APP_PASSWORD` (`lib/bsky.ts` owns the
login for both it and `publish-record`). On fish, prefix with
`env`. Deploy manually with `firebase deploy --only hosting --project dtw-time-zone`,
and the skeleton with `npm run build && npm run build:functions && firebase deploy
--only functions:getFeedSkeleton --project dtw-time-zone`.

## Architecture

A Bluesky feed generator is not a file format — it is three HTTP endpoints.
`getFeedSkeleton` returns only AT-URIs; Bluesky's AppView hydrates post content at
read time, so there is no database. Two of the three are static JSON; the skeleton
is a Cloud Function, because Hosting cannot route on a query string and `cursor` is
a query param.

```
collect  →  data/posts.json    (exact matches, in the feed)
            data/pending.json  (variants, awaiting review)
            data/denied.json   (URIs to never re-add)
   ↓
build    →  public/.well-known/did.json                        ─┐ static
            public/xrpc/app.bsky.feed.describeFeedGenerator     ┘
            functions/entries.json                             ─┐ bundled into
   ↓                                                            │ the function
deploy   →  https://dtw.dimcheff.wtf   (Firebase Hosting)       │
            └─ /xrpc/app.bsky.feed.getFeedSkeleton  ──rewrite──→ getFeedSkeleton
                                                       (gen2, us-central1)
```

`data/` is the source of truth and is committed by CI every 30 minutes. `public/`,
`functions/entries.json` and `functions/index.js` are generated and gitignored.

The function carries its own copy of the archive, so a new post is not reachable
until the *function* is redeployed — hosting alone no longer ships the feed's
contents. Two workflows do that, split by who pushed: `update.yml` after the
collector's own commit, `deploy-functions.yml` after any push a human makes.
Between them it happens roughly 40 times a year.

### Identity is permanent

`HOSTNAME`, `FEED_DID`, and `FEED_RKEY` in `src/config.ts` are baked into the feed's
AT-URI. Changing any of them orphans every subscriber. `SERVICE_ENDPOINT` is
deliberately separate from `FEED_DID`: a DID document may point `serviceEndpoint` at
a different host. Pagination did not need it — the skeleton became a function
behind a rewrite on the same host — but it remains the escape hatch for moving the
serving layer elsewhere without changing the feed's identity.

## Constraints that fail silently

These were each discovered the hard way. All of them break the feed in ways that
look like nothing happening.

- **Search requires authentication.** `api.bsky.app` refuses unauthenticated
  `searchPosts` cursor requests with `403 Request forbidden by administrative
  rules`, and has been seen refusing first pages. There is no anonymous fallback;
  missing credentials exit cleanly, rejected ones fail the run.
- **Hosted static content beats rewrites.** A leftover file at
  `public/xrpc/app.bsky.feed.getFeedSkeleton` shadows the function and silently
  restores the one-page feed. `build.ts` deletes it on every run rather than merely
  not writing it, because the file only has to exist in the tree you deploy from.
- **`firebase.json` `headers` are matched before rewrites and override a
  function's own response headers.** The `/xrpc/**` rule was narrowed to the one
  remaining static path for exactly this reason: a glob there would have stamped
  `max-age=300` onto the skeleton's error responses, turning a bad request into a
  five-minute outage.
- **`getFeed` slices to `params.limit` *before* reading our cursor.** Returning
  more entries than the request asked for drops everything past the limit without
  ever paging to it. Clamping down is always safe; serving extra never is.
- **An echoed cursor, or an empty page, ends the walk.** `cursor === params.cursor
  || feedSkele.length === 0` is read as end-of-feed. The cursor is therefore always
  derived from the last entry actually returned, and a page is empty only when the
  cursor is past the end.
- **The AppView aborts a feed generator at 10s with zero retries**
  (`AbortSignal.timeout(10_000)`, `maxRetries` defaults to 0). One slow cold start
  is a user-visible "feed unavailable", which is why the function reads a bundled
  file rather than fetching anything.
- **`getFeedGenerator`'s `isValid`/`isOnline` are hard-coded `true`** in the
  AppView, with a `@TODO`. They cannot fail, for any reason, including the endpoint
  being deleted. Do not treat them as a health signal — `npm run verify`'s cursor
  walk is the health signal.
- **A push made with `GITHUB_TOKEN` does not start a workflow run.** This is why
  the function is deployed from *two* places. `deploy-functions.yml` is
  `paths`-filtered and covers pushes made by a human — code changes, and a merged
  review PR. The collector's own push is made with the bot's token, so that filter
  never fires for it, and `update.yml` deploys the function inline instead.
  Its gate is deliberately not `data/posts.json changed in this run's commit` —
  that is blind to everything the run did not commit itself, a merged review PR
  first among them. It asks the deployed endpoint instead.
- **Firebase's default `ignore` glob `**/.*` excludes `.well-known`**, which makes
  `did:web` resolution 404. `firebase.json` enumerates exclusions explicitly — do
  not reintroduce the glob.
- **XRPC paths are extensionless**, so Firebase infers `application/octet-stream`
  and the AppView rejects the response. `firebase.json` forces the content type for
  `describeFeedGenerator`; the skeleton function sets its own.
- **`createdAt` is client-supplied and unverified** — the archive contains a post
  dated 2009. Order by `sortAtMs` (`min(createdAt, indexedAt)`), compared as
  instants, never by `createdAt` alone.
- **A conflicting PR gets zero CI runs**, not a failure, because `pull_request`
  workflows run against a merge commit GitHub cannot create. Rebase on `main`.

## Matching

`src/lib/match.ts` decides what enters a permanent archive, so changes there deserve
tests. The corpus contains many sincere posts about time zones (Indiana, South Bend,
the UP) that read almost identically to the joke.

- **exact** → auto-admitted. Accepts `michigan`, `mich`, and `mi`.
- **variant** → review queue, requires a human decision.
- **ignore** → dropped, not stored.

Two independent routes reach **variant**, and only the first is about Detroit:

1. The eastern frame plus a **local term**. Local terms match on **word
   boundaries**, not substrings: `mi` appears inside "admit", "midwest" and
   "miles", all of which occur in sincere posts.
2. The **announcement construction in any time zone** — "Jackson Hole, Wyoming
   is in the Mountain Time Zone" (#4). This one reads *raw* text, not
   `normalize()` output, because `normalize` collapses the punctuation the rule
   depends on.

The shape gate is deliberately case-insensitive, which costs it the free
exclusion of "my family is in the eastern time zone". What separates it from
sincere geography is instead: the place must **open a clause** (sincere posts
bury it — "most of Indiana is in the…"), must be **at most three words**, then
at most two more after an optional comma, and must not **start with a
determiner, quantifier or pronoun** (`PLACE_STOP`). Nothing here can return
`exact`; a place-swap is always a human decision.

The zone slot is **open, with a blocklist** (`ZONE_STOP`), not a list of real
time zones. An allowlist is a gazetteer that never finishes losing: the US-zone
list it replaced dropped "Athens, Greece is in the Eastern European Time Zone"
and "Istanbul, Turkey is in the Turkey Time Zone", and would have gone on
dropping every zone nobody thought to add. The noise filling that slot is
always a determiner — "is in the wrong time zone" — and *that* list is finite.

`VARIANT_QUERIES` cannot be open the same way, since a phrase query is a
literal substring. It is a handful of the highest-yield zones, each measured
rather than guessed, and it is expected to miss creative ones — the documented
answer there is to add the post by hand.

`collect.ts` reclassifies the queue on load, so matcher changes apply retroactively
to queued posts without re-querying. `denied.json` is applied at load and outranks
an exact match — it is the only way to permanently remove a post.

## Serving

`src/lib/skeleton.ts` is the paginator and `src/functions/index.ts` the handler;
`src/lib/order.ts` holds the total order both the build and the function sort by.
The cursor is `base64url("<sortAtMs>:<uri>")` — a *position* in that order, not an
offset, which is what keeps a walk stable while review admissions backfill into the
middle of it.

Three details there are load-bearing and none fail loudly, so they carry comments
and fixture tests: parse the cursor with `indexOf(":")` (an AT-URI contains colons,
and `split` makes every page repeat its last entry), compare the `uri` tiebreaker
with `<`/`>` rather than `localeCompare` (ICU- and locale-dependent, and the build
and the function run in different containers), and never return more than `limit`.

The corpus has no `sortAt` ties, so no test over committed data can catch a
regression in the tiebreaker — that is what `skeleton.test.ts`'s fixtures are for.

`walkFeed` in `skeleton.ts` is the one implementation of a cursor walk. The
fixture tests, the corpus test and `npm run verify` all go through it, so the
local paginator and the deployed endpoint are held to the same contract; only
the page-fetcher differs.

## Workflow ordering

`.github/workflows/update.yml` has three order dependencies that are easy to "fix"
into bugs:

- **`npm run check` runs after `Collect`, deliberately.** Collect is what repairs
  the corpus invariants (it filters denied entries and reclassifies the queue).
  Asserting them first wedges every run on a hand-edit the next step would fix.
  Typecheck runs first so a syntax error costs no API sweep.
- **`Build` runs after the push**, since a rebase can pull in a review PR that
  admitted posts.

- **`Deploy feed function (archive stale)` runs after the hosting deploy and
  before `Verify`**. The archive is bundled into the function, so `verify`'s cursor
  walk — which asserts the endpoint serves exactly what `data/posts.json` holds —
  is only true once it has run.

The push-conflict path re-collects and re-checks; keep both.

### The other workflow

`.github/workflows/deploy-functions.yml` ("Deploy feed function (push)") is the
second half of the same job: the two are split by *who pushed*, not by what
changed. `update.yml`'s step covers the collector's own push, which triggers no
workflow; this one covers every push a human makes, which is why `data/posts.json`
is in its `paths` filter alongside the code. Admitting a post by hand is the case
that needs it — merging that PR is the only way the archive changes without the
collector committing anything.

The two hold **separate** concurrency groups and can therefore deploy the function
at the same time, last writer winning. Sharing one group is worse, not better: a
merge's deploy would queue behind a running collection, and GitHub cancels a
*pending* run when a newer one queues, so the next half-hourly tick would delete
it outright. The race is settled after the fact instead — `update.yml` gates its
deploy on asking the live endpoint whether it already serves `data/posts.json`,
so any archive that reaches `main` undeployed, by any route, ships within thirty
minutes. That gate, not the `paths` filter, is what makes the feed
self-correcting; the filter only makes a merged review PR fast.

Its `paths` filter is deliberately `src/**` rather than the function's import
graph. The filter has to track two dependency graphs — what the bundle imports,
and what produces `entries.json` at build time — and only the first is
mechanical. A narrow list that missed the second would leave the function serving
a stale ordering with nothing failing.

## Tests

`node:test` via tsx, no framework. `src/lib/corpus.test.ts` asserts invariants
against the committed data, not fixtures — every archived post still matches,
nothing denied reappears, the queue holds nothing auto-admittable.

File order in `data/posts.json` is deliberately **not** asserted: the documented way
to admit a post is to move its entry, which does not produce sorted output, and
`writePosts` and `build.ts` both sort anyway.

## Reviewing candidates

The Action opens or comments on a `pending-review` issue when new candidates appear.
Admit by moving the entry from `pending.json` to `posts.json`; reject by deleting it
and adding its `uri` to `denied.json`.

Riffs were held in the queue rather than denied for as long as #4 was open, because
`denied.json` is applied at load and outranks an exact match -- denying a riff
removed the very corpus the detector was being built against. #4 shipped, and the
queue filled with the riffs it can now reach, so that hold is over: a riff is an
ordinary variant awaiting a yes or a no. Three are already in the archive.

The `review-queue` skill (`.claude/skills/review-queue`) drives a session end to
end -- categorize, decide, apply, PR -- and `npm run apply-review` is the mutation
under it. Both are conveniences; hand-editing the three files is still correct.

Open work is tracked as GitHub issues; `TODO.md` is only an index.

## Merging PRs

Merge with a merge commit, never squash. A PR should already be a series of
well-factored commits — split unrelated changes, keep noisy generated output
(`data/` updates, `functions/entries.json`) separate from code changes — rather
than one commit for Claude to squash flat later. Merge commits keep that
factoring in `main`'s history instead of collapsing it.

## Removing a mechanism

This repository documents itself in prose next to the code, which means a deleted
mechanism leaves its rationale behind, still reading as current. Before opening a
PR that removes one, grep the tree for its name — `grep -rn windowed` would have
found three stale comments left by #3, and `grep -rn state.json` a fourth.

Comments here cannot be tested. The grep is the test.
