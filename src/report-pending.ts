import { readPending } from "./lib/store.ts";

/**
 * Renders data/pending.json as markdown for the review issue. This is the whole
 * queue, not just what the current run added: the issue is a standing view of
 * what is awaiting a decision.
 */

/** GitHub rejects an issue body or comment over 65536 characters. */
const MAX_BODY = 60_000;

const posts = await readPending();

if (posts.length === 0) {
  console.log("No posts are awaiting review.");
} else {
  const header =
    `${posts.length} post(s) carry the phrase plus a local term but are not exact ` +
    `matches, so they are **not** in the feed.\n`;
  const footer =
    `\n**To admit:** move the entry from \`data/pending.json\` to \`data/posts.json\`.\n` +
    `**To reject:** delete it and add its \`uri\` to \`data/denied.json\`.\n\n` +
    `Edit on a branch and open a PR — do not commit to a bot branch, since the ` +
    `collector rewrites \`data/pending.json\` on every run.`;

  // Entries are newest first, so what gets dropped is the oldest tail rather
  // than whatever the run happened to add last.
  const entries: string[] = [];
  let used = header.length + footer.length;
  let omitted = 0;

  for (const p of posts) {
    const url = `https://bsky.app/profile/${p.authorHandle}/post/${p.uri.split("/").pop()}`;
    // Post text is untrusted and this body is rendered as GitHub Markdown: in a
    // blockquote, an `@handle` or `#123` in someone's post makes the bot mention
    // that GitHub account or cross-link that issue, on every run that surfaces
    // the post. A code fence renders neither. The only sequence that can escape
    // the fence is a fence, so that one is neutralised.
    const text = p.text.replace(/\s+/g, " ").trim().replace(/```/g, "'''");
    const entry =
      `- [@${p.authorHandle}](${url}) · ${p.createdAt.slice(0, 10)}\n\n` +
      `  \`\`\`text\n  ${text}\n  \`\`\`\n`;

    if (used + entry.length > MAX_BODY) {
      omitted++;
      continue;
    }
    used += entry.length;
    entries.push(entry);
  }

  console.log(header);
  for (const entry of entries) console.log(entry);
  if (omitted > 0) {
    console.log(
      `_${omitted} older post(s) omitted to stay under GitHub's body limit — ` +
      `the full queue is in \`data/pending.json\`._\n`,
    );
  }
  console.log(footer);
}
