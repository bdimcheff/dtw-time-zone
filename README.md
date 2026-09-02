# DTW Time Zone

A Bluesky feed of people posting **"Detroit, Michigan is in the Eastern Time Zone"**
— the announcement that used to play on loop at Detroit Metro Airport.

Feed: https://bsky.app/profile/dimcheff.wtf/feed/dtw-time-zone

## How it works

A GitHub Action searches Bluesky every 30 minutes and merges matches into
`data/posts.json`. That cadence is also the feed's latency — a post does not appear
until a run collects and deploys it. There is no database: a Bluesky feed generator
only has to return a list of post URIs, and the AppView hydrates the content at read
time.

Two of the three endpoints are static JSON. The third, `getFeedSkeleton`, is a small
Cloud Function behind a Hosting rewrite, because pagination needs to read a `cursor`
query param and static hosting cannot route on one. It carries its own copy of the
archive, so it is redeployed whenever `data/posts.json` changes.

```
collect  →  data/posts.json   (exact matches, auto-admitted)
            data/pending.json (variants, admitted by review)
   ↓
build    →  public/.well-known/did.json                     ─┐ static
            public/xrpc/app.bsky.feed.describeFeedGenerator  ┘
            functions/entries.json                          ── bundled into ─┐
   ↓                                                                         │
deploy   →  https://dtw.dimcheff.wtf                                         │
            └─ /xrpc/app.bsky.feed.getFeedSkeleton  ──rewrite──→  getFeedSkeleton
```

Matching normalizes case, accents, and punctuation, because the joke is retyped
from memory every time. Exact matches enter the feed automatically. Anything
carrying `is in the eastern time zone` plus a local term (`detroit`, `michigan`,
`dtw`, …) goes to a review queue instead, which keeps sincere posts about Indiana
and South Bend out of the feed.

## Commands

| Command | Effect |
|---|---|
| `npm run collect` | Search and update `data/` |
| `npm run build` | Render `public/` and `functions/entries.json` from `data/posts.json` |
| `npm run build:functions` | Bundle the feed function into `functions/index.js` |
| `npm run verify` | Smoke-test the deployed endpoints |
| `npm run publish-record` | Publish the feed record (one-time, idempotent) |
| `npm run check` | Typecheck and run the tests |
| `npm run test` | Tests only |
| `npm run pending-report` | Render the review queue as markdown |
| `npm run apply-review` | Apply a review session's decisions to `data/` |

## Tests

`npm run check` typechecks and runs the tests, which cover the matcher and the feed
sort key — the two places where a plausible-looking change quietly reshapes a
permanent archive. Cases come from the real corpus, and `src/lib/corpus.test.ts`
asserts invariants against the committed data itself: every archived post still
matches, nothing denied reappears, and the queue holds nothing the matcher would
auto-admit. CI runs them on pull requests, and again after collecting —
before anything is committed or deployed — since collect is what repairs those
invariants.

## Reviewing variants

The Action opens (or comments on) an issue when new candidates appear. For each entry in
`data/pending.json`:

- **Admit** — move the entry into `data/posts.json`.
- **Reject** — delete it and add its `uri` to `data/denied.json` so it is not
  re-queued.

Both are hand edits and stay supported. `npm run apply-review -- decisions.json`
applies a batch of them from a `{ "admit": [...], "deny": [...] }` file instead,
which is what the `review-queue` skill in `.claude/skills/` drives: it reads the
queue, groups it, and asks. Rejection is permanent -- `denied.json` is applied at
load and outranks an exact match -- so a queue read in summary is a queue to leave
alone.

### If a review PR shows no checks

A pull request with merge conflicts gets **no CI run at all** — not a failure, zero
runs — because `pull_request` workflows execute against a merge commit GitHub cannot
create. In the UI that is easy to mistake for a PR that passed.

The collector commits to `data/` on every run that finds something, so a review PR
left open for a while can conflict. Rebase it on `main` and the checks appear.

## Setup

Required once. **[SETUP.md](SETUP.md) has the same steps as copy-pasteable CLI
commands**, including creating the custom domain via the Hosting REST API, which the
`firebase` CLI cannot do.

**1. Firebase Hosting.** The feed lives in its own Firebase project, `dtw-time-zone`,
rather than alongside the blog in `bdimcheff`. This keeps the CI service account
scoped to a project that can't touch anything else, and avoids multi-site hosting
config. The default site is `dtw-time-zone.web.app`, which is also useful for
testing a deploy before DNS is ready.

Add `dtw.dimcheff.wtf` as a custom domain on that site.

**DNS for `dimcheff.wtf` is at Porkbun**, not Google Cloud DNS — that's `dimcheff.com`.
The custom domain needs exactly one record:

| Type | Host | Answer |
|---|---|---|
| `CNAME` | `dtw` | `dtw-time-zone.web.app` |

Porkbun's Host field takes only the subdomain part. No TXT record is needed;
ownership is proven by the CNAME. Note this differs from `brandon.dimcheff.com`,
which predates a Hosting infrastructure change and still uses A records — so the
blog is not a usable template. See [SETUP.md](SETUP.md) for querying the authoritative
records from the API.

**2. Bluesky app password.** Generate one at Settings → App Passwords on
`dimcheff.wtf`.

**3. GitHub secrets.**

| Secret | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Deploys hosting *and* the feed function, so it needs more than Hosting Admin — see [SETUP.md](SETUP.md) §3. Paste the entire JSON. |
| `BSKY_IDENTIFIER` | `dimcheff.wtf` |
| `BSKY_APP_PASSWORD` | Required for search; see below |

**4. Publish the feed record**, after the site is live:

```sh
BSKY_IDENTIFIER=dimcheff.wtf BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
  npm run publish-record
```

It refuses to run until `did:web:dtw.dimcheff.wtf` resolves, since the record is
inert without it.

## Constraints worth knowing

**Collection requires a Bluesky app password.** There is no anonymous fallback:
`api.bsky.app` refuses unauthenticated `searchPosts` requests, and without
credentials the collector exits rather than silently collecting a fraction.

Everything else this feed can break on breaks *silently* — a wrong content type, a
cursor that ends a walk early, a `.well-known` that 404s. Those are catalogued, with
the reasoning, under **Constraints that fail silently** in
[`CLAUDE.md`](CLAUDE.md). Read that before changing the serving path.

## Ideas

Tracked as GitHub issues — an archive page (#5), stats (#6), riffs that keep the
zone but abandon the construction (#19).
[`TODO.md`](TODO.md) is the index.
