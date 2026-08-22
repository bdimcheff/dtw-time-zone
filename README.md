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
            data/pending.json (variants, admitted by merging a PR)
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
| `npm run collect -- --full` | Force an unwindowed sweep of the variant queries |
| `npm run build` | Render `public/` from `data/posts.json` |
| `npm run verify` | Smoke-test the deployed endpoints |
| `npm run publish-record` | Publish the feed record (one-time, idempotent) |

## Reviewing variants

The Action opens a PR when new candidates appear. For each entry in
`data/pending.json`:

- **Admit** — move the entry into `data/posts.json`.
- **Reject** — delete it and add its `uri` to `data/denied.json` so it is not
  re-queued.

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
Firebase issues a TXT record for ownership first, then the A record(s). In Porkbun's
DNS Records page the Host field takes only the subdomain part (`dtw`, not the full
name).

Use exactly what the console shows. Firebase Hosting has changed IPs over time —
this project resolves to `199.36.158.100`, whereas the older `brandon.dimcheff.com`
still points at a `151.101.x` pair, so the blog is not a reliable template.
Certificate provisioning is the slow step, usually under an hour. `npm run verify`
confirms when it's live.

**2. Bluesky app password.** Generate one at Settings → App Passwords on
`dimcheff.wtf`.

**3. GitHub secrets.**

| Secret | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Deploy. From the **`dtw-time-zone`** project → Project settings → Service accounts. Paste the entire JSON. |
| `BSKY_IDENTIFIER` | `dimcheff.wtf` |
| `BSKY_APP_PASSWORD` | Lifts the single-page search cap (see below) |

**4. Publish the feed record**, after the site is live:

```sh
BSKY_IDENTIFIER=dimcheff.wtf BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
  npm run publish-record
```

It refuses to run until `did:web:dtw.dimcheff.wtf` resolves, since the record is
inert without it.

## Constraints worth knowing

**Unauthenticated search returns one page.** `api.bsky.app` answers
`app.bsky.feed.searchPosts` without auth, but any `cursor` request gets
`403 Request forbidden by administrative rules`. The collector authenticates when
credentials are present and falls back to anonymous single-page access when they
are not. The exact query currently returns 71 results, so it fits either way — but
it will start silently truncating above 100 without auth.

**The feed serves a single page.** Static hosting cannot read the `cursor` query
param, so the feed is the newest 100 posts. `data/posts.json` keeps the full archive
regardless, and `npm run build` warns once posts fall outside the window.

The fix, when that happens, is to point the DID document's `serviceEndpoint` at a
host that can paginate — a Cloudflare Worker is about 30 lines. Because
`serviceEndpoint` may name a different host than the DID itself, this changes where
the feed is served without changing its identity, so no subscriber is affected.

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
