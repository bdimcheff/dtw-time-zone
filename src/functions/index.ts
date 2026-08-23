import { readFileSync } from "node:fs";
import { join } from "node:path";
import { onRequest } from "firebase-functions/v2/https";
import { FEED_URI } from "../config.ts";
import type { FeedEntry } from "../lib/order.ts";
import { BadCursor, paginate } from "../lib/skeleton.ts";

/**
 * app.bsky.feed.getFeedSkeleton, the one endpoint that cannot be a static file:
 * Firebase Hosting cannot route on a query string, so `cursor` needs a request-
 * time handler. did.json and describeFeedGenerator stay static, which is what
 * keeps the feed's identity untouched.
 *
 * The entry list is written by build.ts and deployed with this function, so a
 * request never touches the network. Freshness therefore comes from deploying,
 * which the update workflow does whenever data/posts.json changes.
 */

// Read once at module load, not per request. Deliberately a data file rather than
// a bundled import: a generated file inside src/ would make `npm run typecheck`
// depend on having built first, and typecheck runs before collect in CI.
const entries: FeedEntry[] = JSON.parse(
  readFileSync(join(__dirname, "entries.json"), "utf8"),
);

export const getFeedSkeleton = onRequest(
  {
    region: "us-central1",
    // Pinned rather than inherited: the Compute Engine default service account
    // holds roles/editor on this project. This one holds nothing.
    serviceAccount: "feed-fn-runtime@dtw-time-zone.iam.gserviceaccount.com",
    // The ceiling on a scrape or a cursor loop. Default gen2 concurrency is 80,
    // so this still allows ~240 concurrent requests -- far above any real load.
    maxInstances: 3,
    memory: "256MiB",
    timeoutSeconds: 30,
    minInstances: 0,
    // Answers the CORS preflight for us; the AppView does not send one, but a
    // browser hitting the endpoint directly will.
    cors: true,
  },
  (req, res) => {
    /** XRPC's error shape: {error, message}. Always 400 -- never 404, which
     *  Hosting caches for ten minutes by default, turning one bad request into
     *  an outage for everyone behind the same CDN node. */
    const fail = (error: string, message: string) => {
      res.status(400).set("Cache-Control", "no-store").json({ error, message });
    };

    const { feed, limit, cursor } = req.query;
    const one = (v: unknown) => (typeof v === "string" ? v : undefined);

    // `feed` is required by the lexicon. Missing is a malformed request; present
    // but pointing somewhere else is the declared UnknownFeed.
    const requested = one(feed);
    if (requested === undefined) {
      return fail("InvalidRequest", "Parameter 'feed' is required");
    }
    if (requested !== FEED_URI) {
      return fail("UnknownFeed", `Unknown feed: ${requested}`);
    }

    // The Authorization header, when present, is a service JWT the requester's
    // PDS minted for FEED_DID. It is absent for logged-out requests, and this
    // feed is public and unpersonalized, so it is deliberately ignored --
    // rejecting on either its presence or its absence would break one of the two.

    let page;
    try {
      page = paginate(entries, { limit: one(limit), cursor: one(cursor) });
    } catch (err) {
      if (err instanceof BadCursor) {
        return fail("InvalidRequest", err.message);
      }
      throw err;
    }

    res
      .set("Content-Type", "application/json; charset=utf-8")
      // Short: the AppView sends a unique per-request JWT and Hosting adds
      // Authorization to Vary for dynamic content, so authenticated traffic
      // essentially never hits the CDN anyway. This only bounds the anonymous case.
      .set("Cache-Control", "public, max-age=60")
      .json(page);
  },
);
