import { readPending } from "./lib/store.ts";

/**
 * Renders data/pending.json as markdown for the review issue. This is the whole
 * queue, not just what the current run added: the issue is a standing view of
 * what is awaiting a decision.
 */

/**
 * GitHub rejects a body over 65536 characters, and the step that posts it runs
 * with continue-on-error, so exceeding the limit loses the notification silently.
 *
 * Bounded by construction rather than by assertion: a post's text is capped at
 * 3000 bytes by the lexicon, so an entry count alone does not bound the body --
 * 100 maximal posts would be ~315,000 characters. Truncating each excerpt first
 * puts the worst case at roughly 100 x 450, comfortably inside the limit.
 */
const MAX_ENTRIES = 100;
const MAX_EXCERPT = 300;

const FENCE = "```";

const posts = await readPending();

if (posts.length === 0) {
  console.log("No posts are awaiting review.");
} else {
  console.log(
    `${posts.length} post(s) carry the phrase plus a local term but are not exact ` +
    `matches, so they are **not** in the feed.\n`,
  );

  for (const p of posts.slice(0, MAX_ENTRIES)) {
    const url = `https://bsky.app/profile/${p.authorHandle}/post/${p.uri.split("/").pop()}`;
    // Post text is untrusted and this body renders as GitHub Markdown: in a
    // blockquote, an `@handle` or `#123` inside someone's post would mention that
    // account or cross-link that issue on every run that surfaces the post. A code
    // fence renders neither, and the only sequence that escapes a fence is a fence.
    const full = p.text.replace(/\s+/g, " ").trim().replaceAll(FENCE, "'''");
    const text = full.length > MAX_EXCERPT ? `${full.slice(0, MAX_EXCERPT)}…` : full;
    console.log(
      `- [@${p.authorHandle}](${url}) · ${p.createdAt.slice(0, 10)}\n\n` +
      `  ${FENCE}text\n  ${text}\n  ${FENCE}\n`,
    );
  }

  if (posts.length > MAX_ENTRIES) {
    console.log(
      `_${posts.length - MAX_ENTRIES} older post(s) omitted — the full queue is in ` +
      "`data/pending.json`._\n",
    );
  }

  console.log(
    "\n**To admit:** move the entry from `data/pending.json` to `data/posts.json`.\n" +
    "**To reject:** delete it and add its `uri` to `data/denied.json`.\n\n" +
    "Edit on a branch and open a PR — do not commit to a bot branch, since the " +
    "collector rewrites `data/pending.json` on every run.",
  );
}
