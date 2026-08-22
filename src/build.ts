import {
  FEED_DID, FEED_LIMIT, FEED_RKEY, HOSTNAME, PUBLISHER_DID, SERVICE_ENDPOINT,
} from "./config.ts";
import { readPosts } from "./lib/store.ts";
import { writePublic } from "./lib/store.ts";

/** AT-URI of the app.bsky.feed.generator record clients subscribe to. */
export const FEED_URI = `at://${PUBLISHER_DID}/app.bsky.feed.generator/${FEED_RKEY}`;

async function main(): Promise<void> {
  const posts = await readPosts();

  // did:web resolution reads exactly this path. The serviceEndpoint is allowed
  // to name a different host than the DID, which is what lets the serving layer
  // move later without changing the feed's identity.
  await writePublic(".well-known/did.json", {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: FEED_DID,
    service: [
      {
        id: "#bsky_fg",
        type: "BskyFeedGenerator",
        serviceEndpoint: SERVICE_ENDPOINT,
      },
    ],
  });

  await writePublic("xrpc/app.bsky.feed.describeFeedGenerator", {
    did: FEED_DID,
    feeds: [{ uri: FEED_URI }],
  });

  // Static hosting can't read the cursor query param, so this is a single page:
  // the newest FEED_LIMIT posts, with no cursor to signal there is no more.
  // data/posts.json keeps the complete archive regardless.
  const feed = posts.slice(0, FEED_LIMIT).map((p) => ({ post: p.uri }));
  await writePublic("xrpc/app.bsky.feed.getFeedSkeleton", { feed });

  console.log(`built ${feed.length} skeleton entries from ${posts.length} archived posts`);
  // The AppView slices this to the client's `limit` and stops, since we return no
  // cursor, so subscribers see far fewer than we serve. See TODO.md.
  console.log(
    `  note: subscribers see only the newest ~30-50 of these until the feed paginates`,
  );
  console.log(`  did:      ${FEED_DID}`);
  console.log(`  feed uri: ${FEED_URI}`);
  console.log(`  host:     https://${HOSTNAME}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
