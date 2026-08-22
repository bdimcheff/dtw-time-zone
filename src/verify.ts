import { APPVIEW, FEED_DID, HOSTNAME, USER_AGENT, PUBLISHER_DID, FEED_RKEY } from "./config.ts";

/**
 * Post-deploy smoke test. Each of these failures makes the feed break in a way
 * that is hard to trace from the Bluesky app: a wrong content type or a missing
 * .well-known just renders as an empty or unavailable feed.
 */

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

async function getJson(url: string): Promise<{ status: number; type: string; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  } catch (err) {
    // Unreachable host (DNS not configured yet, TLS still provisioning) is a
    // check failure, not a crash.
    const cause = (err as { cause?: { code?: string } })?.cause?.code ?? "network error";
    return { status: 0, type: `unreachable (${cause})`, body: null };
  }
  const type = res.headers.get("content-type") ?? "";
  let body: unknown = null;
  try { body = await res.json(); } catch { /* checked via type below */ }
  return { status: res.status, type, body };
}

async function main(): Promise<void> {
  const didUrl = `https://${HOSTNAME}/.well-known/did.json`;
  const did = await getJson(didUrl);
  check(did.status === 200, "did.json reachable", `HTTP ${did.status}`);
  check(
    did.type.includes("application/json"),
    "did.json content type",
    did.type || "(none)",
  );
  check((did.body as { id?: string })?.id === FEED_DID, "did.json declares the right DID");

  const skelUrl = `https://${HOSTNAME}/xrpc/app.bsky.feed.getFeedSkeleton`;
  const skel = await getJson(skelUrl);
  check(skel.status === 200, "getFeedSkeleton reachable", `HTTP ${skel.status}`);
  // The AppView's XRPC client rejects responses that aren't declared as JSON,
  // and Firebase infers octet-stream for these extensionless paths by default.
  check(
    skel.type.includes("application/json"),
    "getFeedSkeleton content type",
    skel.type || "(none)",
  );
  const feed = (skel.body as { feed?: unknown[] })?.feed;
  check(Array.isArray(feed) && feed.length > 0, "getFeedSkeleton returns posts", `${feed?.length ?? 0} entries`);

  const desc = await getJson(`https://${HOSTNAME}/xrpc/app.bsky.feed.describeFeedGenerator`);
  check(desc.status === 200, "describeFeedGenerator reachable", `HTTP ${desc.status}`);
  check(desc.type.includes("application/json"), "describeFeedGenerator content type", desc.type || "(none)");

  // Only present once publish-record.ts has run; absence is reported, not fatal.
  const feedUri = `at://${PUBLISHER_DID}/app.bsky.feed.generator/${FEED_RKEY}`;
  const gen = await getJson(
    `${APPVIEW}/xrpc/app.bsky.feed.getFeedGenerator?feed=${encodeURIComponent(feedUri)}`,
  );
  if (gen.status === 200) {
    const view = gen.body as { isValid?: boolean; isOnline?: boolean };
    check(view.isValid !== false, "AppView considers the feed valid");
    check(view.isOnline !== false, "AppView considers the feed online");
  } else {
    console.log(`· feed record not published yet (HTTP ${gen.status}) — run npm run publish-record`);
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
