import { AtpAgent } from "@atproto/api";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FEED_DID, FEED_DESCRIPTION, FEED_NAME, FEED_RKEY,
  HOSTNAME, PUBLISHER_DID, PUBLISHER_HANDLE, USER_AGENT,
} from "./config.ts";

/**
 * One-time (and idempotent) publication of the app.bsky.feed.generator record.
 * This is what makes the feed discoverable and subscribable; it points at
 * FEED_DID, which must already resolve.
 */

/** The record is inert until did:web resolution works, so check first. */
async function preflight(): Promise<void> {
  const url = `https://${HOSTNAME}/.well-known/did.json`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${url} returned ${res.status} — deploy the site first`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      `${url} served as "${contentType}", not application/json — check the ` +
      `headers block in firebase.json`,
    );
  }

  const doc = (await res.json()) as { id?: string; service?: Array<{ type?: string }> };
  if (doc.id !== FEED_DID) throw new Error(`DID document declares ${doc.id}, expected ${FEED_DID}`);
  if (!doc.service?.some((s) => s.type === "BskyFeedGenerator")) {
    throw new Error("DID document has no BskyFeedGenerator service entry");
  }
  console.log(`✓ ${FEED_DID} resolves`);
}

async function main(): Promise<void> {
  const identifier = process.env.BSKY_IDENTIFIER;
  const password = process.env.BSKY_APP_PASSWORD;
  if (!identifier || !password) {
    throw new Error("BSKY_IDENTIFIER and BSKY_APP_PASSWORD are required");
  }

  if (process.argv.includes("--skip-preflight")) {
    console.warn("skipping preflight — the feed will not work until the host is live");
  } else {
    await preflight();
  }

  const agent = new AtpAgent({ service: process.env.BSKY_SERVICE ?? "https://bsky.social" });
  await agent.login({ identifier, password });

  // The record's repo determines who is credited as the feed's creator, so a
  // wrong login would publish under the wrong identity.
  if (agent.session?.did !== PUBLISHER_DID) {
    throw new Error(
      `logged in as ${agent.session?.did}, expected ${PUBLISHER_DID} (${PUBLISHER_HANDLE})`,
    );
  }

  let avatar: { $type: string; ref: unknown; mimeType: string; size: number } | undefined;
  try {
    const bytes = await readFile(join(process.cwd(), "assets", "avatar.png"));
    const upload = await agent.uploadBlob(bytes, { encoding: "image/png" });
    avatar = upload.data.blob as unknown as typeof avatar;
    console.log("✓ avatar uploaded");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    console.log("no assets/avatar.png; publishing without an avatar");
  }

  await agent.com.atproto.repo.putRecord({
    repo: agent.session.did,
    collection: "app.bsky.feed.generator",
    rkey: FEED_RKEY,
    record: {
      did: FEED_DID,
      displayName: FEED_NAME,
      description: FEED_DESCRIPTION,
      ...(avatar ? { avatar } : {}),
      createdAt: new Date().toISOString(),
    },
  });

  const uri = `at://${agent.session.did}/app.bsky.feed.generator/${FEED_RKEY}`;
  console.log(`\n✓ published ${uri}`);
  console.log(`  https://bsky.app/profile/${PUBLISHER_HANDLE}/feed/${FEED_RKEY}`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
