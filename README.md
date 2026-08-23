# DTW Time Zone

A Bluesky feed of people posting **"Detroit, Michigan is in the Eastern Time Zone"**
— the announcement that used to play on loop at Detroit Metro Airport.

Feed: https://bsky.app/profile/dimcheff.wtf/feed/dtw-time-zone

## How it works

A GitHub Action searches Bluesky a few times a day, merges matches into
`data/posts.json`, and renders three static JSON files that Firebase serves. There
is no server — a Bluesky feed generator only has to return a list of post URIs, and
the AppView hydrates the content at read time.

```
collect  →  data/posts.json   (exact matches, auto-admitted)
            data/pending.json (variants, admitted by review)
   ↓
build    →  public/.well-known/did.json
            public/xrpc/app.bsky.feed.describeFeedGenerator
            public/xrpc/app.bsky.feed.getFeedSkeleton
   ↓
deploy   →  https://dtw.dimcheff.wtf
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
| `npm run build` | Render `public/` from `data/posts.json` |
| `npm run verify` | Smoke-test the deployed endpoints |
| `npm run publish-record` | Publish the feed record (one-time, idempotent) |
| `npm run check` | Typecheck and run the tests |

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
| `FIREBASE_SERVICE_ACCOUNT` | Deploy. From the **`dtw-time-zone`** project → Project settings → Service accounts. Paste the entire JSON. |
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

**Collection requires a Bluesky app password.** `api.bsky.app` refuses
unauthenticated `searchPosts` cursor requests with `403 Request forbidden by
administrative rules`, and has been observed refusing first pages too. Measured
against the same query, anonymous returned nothing while authenticated returned all
170 results across 2 pages. There is no anonymous fallback: without credentials the
collector exits rather than silently collecting a fraction.

**The feed shows only the newest ~30-50 posts.** Static hosting can't read the
`cursor` query param, so the skeleton is a single page with no cursor. The AppView
slices whatever we return down to the client's requested `limit` and treats a
missing cursor as end-of-feed, so serving more entries doesn't help — subscribers
see one page and stop.

`data/posts.json` keeps the complete archive regardless. Fixing this means moving
the skeleton endpoint to something that can paginate; see
[#2](https://github.com/bdimcheff/dtw-time-zone/issues/2).
Because the DID document's `serviceEndpoint` may name a different host than the DID,
that change doesn't affect the feed's identity or its subscribers.

**`.well-known` and Firebase.** Firebase's default `ignore` list contains `**/.*`,
which excludes `.well-known` and makes `did:web` resolution 404. `firebase.json`
enumerates exclusions explicitly instead. Don't reintroduce the glob.

**GitHub disables cron after 60 days** without repository activity. Re-enable from
the Actions tab.

## Ideas

- Capture riffs on the original form from known posters — *"Jackson Hole, Wyoming is
  in the Mountain Time Zone"*. Needs an author allowlist plus a generalized
  `<place> is in the <X> Time Zone` matcher and its own review gate.
- An archive page listing every captured post. Gains importance once the 100-post
  window binds.
- Stats: posts per year, top posters, first sighting.
