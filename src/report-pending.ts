import { readPending } from "./lib/store.ts";

/** Renders data/pending.json as markdown for the review issue. */
const posts = await readPending();

if (posts.length === 0) {
  console.log("No posts are awaiting review.");
} else {
  console.log(
    `${posts.length} post(s) carry the phrase plus a local term but are not exact ` +
    `matches, so they are **not** in the feed.\n`,
  );
  for (const p of posts) {
    const url = `https://bsky.app/profile/${p.authorHandle}/post/${p.uri.split("/").pop()}`;
    const text = p.text.replace(/\s+/g, " ").trim();
    console.log(`- [@${p.authorHandle}](${url}) · ${p.createdAt.slice(0, 10)}\n  > ${text}`);
  }
  console.log(
    `\n**To admit:** move the entry from \`data/pending.json\` to \`data/posts.json\`.\n` +
    `**To reject:** delete it and add its \`uri\` to \`data/denied.json\`.\n\n` +
    `Edit on a branch and open a PR — do not commit to a bot branch, since the ` +
    `collector rewrites \`data/pending.json\` on every run.`,
  );
}
