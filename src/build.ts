import { FEED_DID, FEED_LIMIT, FEED_URI, HOSTNAME, SERVICE_ENDPOINT } from "./config.ts";
import { byNewest, entriesOf } from "./lib/order.ts";
import { readPosts, writeFunctions, writePublic } from "./lib/store.ts";


// Sorted here rather than trusted: data/posts.json is hand-edited during
// variant review, and a misplaced entry would otherwise silently reorder the feed.
const posts = (await readPosts()).sort(byNewest);

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

// The paginating endpoint's data, deployed inside the function bundle rather than
// fetched at request time: a request then never touches the network, and code and
// data can never disagree about which posts exist. Freshness comes from deploying,
// which the update workflow does whenever data/posts.json changes.
const entries = entriesOf(posts);
await writeFunctions("entries.json", entries);

console.log(`built ${feed.length} skeleton entries from ${posts.length} archived posts`);
console.log(`  functions/entries.json: ${entries.length} entries`);
// The AppView slices this to the client's `limit` and stops, since we return no
// cursor, so subscribers see far fewer than we serve. See TODO.md.
console.log(
  `  note: subscribers see only the newest ~30-50 of these until the feed paginates`,
);
console.log(`  did:      ${FEED_DID}`);
console.log(`  feed uri: ${FEED_URI}`);
console.log(`  host:     https://${HOSTNAME}`);
