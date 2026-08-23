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
| `npm run build` | Render `public/` from `data/posts.json` |
| `npm run verify` | Smoke-test the deployed endpoints |
| `npm run pending-report` | Render the review queue as markdown |
| `npm run publish-record` | Publish the feed record (one-time, idempotent) |

Run a single test file: `node --import tsx --test src/lib/match.test.ts`

`collect` needs `BSKY_IDENTIFIER` and `BSKY_APP_PASSWORD`. On fish, prefix with
`env`. Deploy manually with `firebase deploy --only hosting --project dtw-time-zone`.

## Architecture

A Bluesky feed generator is not a file format — it is three HTTP endpoints, all of
which are **static JSON** here. `getFeedSkeleton` returns only AT-URIs; Bluesky's
AppView hydrates post content at read time, so there is no server and no database.

```
collect  →  data/posts.json    (exact matches, in the feed)
            data/pending.json  (variants, awaiting review)
            data/denied.json   (URIs to never re-add)
   ↓
build    →  public/.well-known/did.json
            public/xrpc/app.bsky.feed.describeFeedGenerator
            public/xrpc/app.bsky.feed.getFeedSkeleton
   ↓
deploy   →  https://dtw.dimcheff.wtf   (Firebase, own GCP project)
```

`data/` is the source of truth and is committed by CI every 30 minutes. `public/`
is generated and gitignored.

### Identity is permanent

`HOSTNAME`, `FEED_DID`, and `FEED_RKEY` in `src/config.ts` are baked into the feed's
AT-URI. Changing any of them orphans every subscriber. `SERVICE_ENDPOINT` is
deliberately separate from `FEED_DID`: a DID document may point `serviceEndpoint` at
a different host, which is the escape hatch for moving off static hosting without
changing the feed's identity.

## Constraints that fail silently

These were each discovered the hard way. All of them break the feed in ways that
look like nothing happening.

- **Search requires authentication.** `api.bsky.app` refuses unauthenticated
  `searchPosts` cursor requests with `403 Request forbidden by administrative
  rules`, and has been seen refusing first pages. There is no anonymous fallback;
  missing credentials exit cleanly, rejected ones fail the run.
- **The feed renders far less than it serves.** The AppView slices the skeleton to
  the client's `limit` and treats an absent cursor as end-of-feed, so subscribers
  see the newest ~30 posts however many entries are returned. Fixing this needs a
  paginating endpoint (issue #2).
- **Firebase's default `ignore` glob `**/.*` excludes `.well-known`**, which makes
  `did:web` resolution 404. `firebase.json` enumerates exclusions explicitly — do
  not reintroduce the glob.
- **XRPC paths are extensionless**, so Firebase infers `application/octet-stream`
  and the AppView rejects the response. `firebase.json` forces the content type.
- **`createdAt` is client-supplied and unverified** — the archive contains a post
  dated 2009. Order by `sortAt` (`min(createdAt, indexedAt)`), compared as instants,
  never by `createdAt` alone.
- **A conflicting PR gets zero CI runs**, not a failure, because `pull_request`
  workflows run against a merge commit GitHub cannot create. Rebase on `main`.

## Matching

`src/lib/match.ts` decides what enters a permanent archive, so changes there deserve
tests. The corpus contains many sincere posts about time zones (Indiana, South Bend,
the UP) that read almost identically to the joke.

- **exact** → auto-admitted. Accepts `michigan`, `mich`, and `mi`.
- **variant** → review queue, requires a human decision.
- **ignore** → dropped, not stored.

Local terms match on **word boundaries**, not substrings: `mi` appears inside
"admit", "midwest" and "miles", all of which occur in sincere posts.

`collect.ts` reclassifies the queue on load, so matcher changes apply retroactively
to queued posts without re-querying. `denied.json` is applied at load and outranks
an exact match — it is the only way to permanently remove a post.

## Workflow ordering

`.github/workflows/update.yml` has two order dependencies that are easy to "fix"
into bugs:

- **`npm run check` runs after `Collect`, deliberately.** Collect is what repairs
  the corpus invariants (it filters denied entries and reclassifies the queue).
  Asserting them first wedges every run on a hand-edit the next step would fix.
  Typecheck runs first so a syntax error costs no API sweep.
- **`Build` runs after the push**, since a rebase can pull in a review PR that
  admitted posts.

The push-conflict path re-collects and re-checks; keep both.

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
and adding its `uri` to `denied.json`. Denying a *riff* forecloses it for issue #4,
so riffs are left queued rather than denied.

Open work is tracked as GitHub issues; `TODO.md` is only an index.
