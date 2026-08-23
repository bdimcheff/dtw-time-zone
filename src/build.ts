import { FEED_DID, FEED_URI, HOSTNAME, SERVICE_ENDPOINT } from "./config.ts";
import { entriesOf } from "./lib/order.ts";
import { readPosts, unlinkPublic, writeFunctions, writePublic } from "./lib/store.ts";


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

// getFeedSkeleton is deliberately absent from public/: Hosting serves static
// content in preference to rewrites, so a file at that path would shadow the
// function and silently restore the single-page feed. Removed rather than merely
// not written, so a tree that still holds one from an older build cannot deploy it.
await unlinkPublic("xrpc/app.bsky.feed.getFeedSkeleton");
//
// The function's data is deployed inside its bundle rather than fetched at request
// time, so a request never touches the network and code and data cannot disagree
// about which posts exist. Freshness comes from deploying, which the update
// workflow does whenever data/posts.json changes.
// entriesOf sorts rather than trusting file order: data/posts.json is hand-edited
// during variant review, and a misplaced entry would otherwise reorder the feed.
const entries = entriesOf(posts);
await writeFunctions("entries.json", entries);

console.log(`built ${entries.length} feed entries from ${posts.length} archived posts`);
console.log(`  did:      ${FEED_DID}`);
console.log(`  feed uri: ${FEED_URI}`);
console.log(`  host:     https://${HOSTNAME}`);
