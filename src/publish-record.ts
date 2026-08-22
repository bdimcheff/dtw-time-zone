import { AtpAgent } from "@atproto/api";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** The generator lexicon accepts only PNG and JPEG, capped at 1MB. */
const AVATAR_CANDIDATES = [
  ["assets/avatar.png", "image/png"],
  ["assets/avatar.jpg", "image/jpeg"],
  ["assets/avatar.jpeg", "image/jpeg"],
] as const;

const AVATAR_MAX_BYTES = 1_000_000;

/** Resolved from the module, not cwd, so the script works from any directory. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function uploadAvatar(agent: AtpAgent): Promise<unknown | undefined> {
  for (const [relPath, mimeType] of AVATAR_CANDIDATES) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(ROOT, relPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (bytes.byteLength > AVATAR_MAX_BYTES) {
      throw new Error(
        `${relPath} is ${bytes.byteLength} bytes; the lexicon caps avatars at ${AVATAR_MAX_BYTES}`,
      );
    }
    const upload = await agent.uploadBlob(bytes, { encoding: mimeType });
    console.log(`✓ avatar uploaded from ${relPath}`);
    return upload.data.blob;
  }
  console.log("no avatar found in assets/; publishing without one");
  return undefined;
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

  const avatar = await uploadAvatar(agent);

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
