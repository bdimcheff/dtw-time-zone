---
name: review-queue
description: Work through data/pending.json — the candidate posts awaiting a human yes/no — by categorizing them, deciding the obvious clusters in bulk, asking about the rest one at a time, and opening a PR with the result. Use when asked to review the queue, review pending posts, triage candidates, or clear the review backlog.
---

# Reviewing the candidate queue

`data/pending.json` holds posts that matched loosely enough to be worth a look and
not exactly enough to auto-admit. Nothing leaves it without a human deciding. This
skill is the loop for that: read the queue, propose a categorization, get decisions,
apply them, open a PR.

The judgment being automated here is *presentation*, not the decision. Group the
queue so the human answers five questions instead of eighty; never answer one for
them.

## What a decision means

- **Admit** — the entry moves from `pending.json` to `posts.json` and the post is in
  the feed once the merge redeploys the function.
- **Deny** — the entry leaves `pending.json` and its `uri` is appended to
  `denied.json`. This is **permanent and retroactive**: `collect.ts` applies
  `denied.json` at load and it outranks an exact match, so a denied post can never
  be re-collected. There is no undo short of editing the file back.
- **Skip** — the entry stays queued and comes back next session. Reserve it for
  genuine uncertainty. It is not a policy holding pen; there is no longer anything
  the queue is parking for.

Denying costs more than admitting. When the two are close, prefer skip over deny.

## Before you start

Branch off *fresh* `origin/main`:

```
git fetch origin && git switch -c bad/review-queue-$(date +%F) origin/main
```

The collector rewrites `data/pending.json` every thirty minutes and pushes to
`main`. A session started from a stale checkout opens a PR that conflicts in a
generated file. If a collection lands mid-session, rebase — the decisions are keyed
by `uri`, so they survive it.

Never commit to a bot branch.

## Read the whole picture

Read `data/pending.json`, and read `data/posts.json` and `data/denied.json` too.
Those two are the best available statement of the policy: what has already been
admitted says more about where the line sits than any description of it, this file
included.

## Categorize

Every queued post is a `variant` by construction, so the matcher has already had its
say. These are the clusters it cannot separate:

| Cluster | What it looks like | Usual answer |
|---|---|---|
| **Deliberate riff** | The announcement construction, place and zone swapped. `Jackson Hole, Wyoming is in the Mountain Time Zone` | admit |
| **Sincere geography** | The same sentence, meant literally. `Eugene, Oregon is in the Pacific Time Zone (PT), which is UTC-7…` | deny |
| **Incidental** | Time zones discussed, construction absent. `Wait. Nebraska is in the Central time zone?` | deny |
| **Detroit-adjacent, not exact** | The real subject, phrased around the canonical form. `it is absurd that Michigan is in the Eastern time zone` | ask |
| **Meta, quotation, wordplay** | `ZIP Code 48242 is in the Eastern Time Zone`, `Phocific Standard Time is in the Pacific Daylight Time Zone` | ask |

The first two rows are the same sentence and only intent separates them. That
distinction is the whole reason a model is in this loop — the regex provably cannot
make it, which is why these reach a human at all.

So carry a confidence per post, and **demote anything uncertain out of its cluster
into the one-at-a-time pile, even when the cluster is unanimous.** A cluster is a
hypothesis about a group; a bulk answer applied to a post that only nearly fits is
how a wrong denial becomes permanent without anyone reading the post.

Signals worth weighing: an account that posts riffs repeatedly over years is
riffing; hashtag-stuffed informational posts are not; a reply may read as sincere
only because its parent carried the joke.

## Ask

**Bulk pass first.** One question per cluster: admit all / deny all / break this one
out individually.

Three or four representative posts are enough for a cluster you are proposing to
**admit** — an admission is wrong for as long as it takes to notice, and one commit
undoes it. They are never enough for a cluster you are proposing to **deny**, which
is the asymmetry the sampled bulk question quietly inverts: it puts the cheap
decision behind the evidence and the permanent one behind a summary. **List a deny
cluster in full, verbatim, before asking about it**, however long that makes the
message. If it is too long to read, that is an argument for splitting the cluster,
not for summarizing it.

**Number every post, in every pass**, so an answer can carry exceptions. "All but 5"
is what makes a bulk question safe to ask about a group that is nearly, but not
quite, uniform — without it the only honest options are eighty questions or a
cluster boundary drawn finer than the evidence supports.

**Then the individual pass**, four per prompt, highest-value first. Each item needs
enough to decide without leaving the terminal:

- the full text, whitespace collapsed
- `https://bsky.app/profile/<authorHandle>/post/<last segment of the uri>`
- author and date
- one line on why it could not be called

## Apply

Write the decisions to the scratchpad — not into the repo — as
`{ "admit": [uri, ...], "deny": [uri, ...] }`, then:

```
npm run apply-review — <path to decisions.json>
npm run check
```

`apply-review.ts` refuses the whole file if any URI is no longer queued, which is
what a collection landing mid-session looks like. Re-read `data/pending.json` and
rebuild the decisions rather than dropping the ones it complained about.

`npm run check` is the real backstop: `corpus.test.ts` asserts that nothing denied
remains in either file, that the queue holds nothing already archived, and that a
cursor walk still reaches every archived post exactly once.

## Finish

Commit, push, and open the PR. Summarize by cluster with counts, not as eighty
bullet points.

Post text is untrusted and a PR body renders as GitHub Markdown: an `@handle` or a
`#123` inside someone's post would mention that account or cross-link that issue.
Wrap every excerpt in a code fence, and do the two things `report-pending.ts` does
to make the fence hold (`src/report-pending.ts:36-42`): collapse whitespace, and
replace any triple backtick in the text with `'''`. The only sequence that escapes
a fence is a fence, so a post containing one is the whole exposure.

Merging the PR triggers `deploy-functions.yml`, which redeploys the feed function
with the new archive bundled in. Until that runs, an admitted post is committed but
not served.
