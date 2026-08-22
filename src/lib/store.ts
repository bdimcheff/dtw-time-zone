import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredPost, PendingPost, CollectorState } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(ROOT, "data");
export const PUBLIC_DIR = join(ROOT, "public");

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Trailing newline and stable formatting keep git diffs readable, since these
  // files are committed by the update workflow on every run.
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

const postsPath = join(DATA_DIR, "posts.json");
const pendingPath = join(DATA_DIR, "pending.json");
const deniedPath = join(DATA_DIR, "denied.json");
const statePath = join(DATA_DIR, "state.json");

export const readPosts = () => readJson<StoredPost[]>(postsPath, []);
export const readPending = () => readJson<PendingPost[]>(pendingPath, []);
export const readState = () =>
  readJson<CollectorState>(statePath, { lastRunAt: null, lastFullSweepAt: null });

/** URIs manually rejected; never re-enter pending. Hand-edited. */
export const readDenied = async () => new Set(await readJson<string[]>(deniedPath, []));

/**
 * `createdAt` is client-supplied and unverified: the archive already contains a
 * post dated 2009, years before Bluesky existed. Sorting on it alone would let
 * anyone pin themselves to the top of the feed forever by posting a future date.
 * Taking the earlier of createdAt and indexedAt caps a post at the moment the
 * network actually saw it, which is how the AppView derives its own sort key.
 */
export const sortAt = (p: StoredPost): string =>
  p.createdAt < p.indexedAt ? p.createdAt : p.indexedAt;

/** Newest first, so the feed skeleton is a prefix of this array. */
const byNewest = (a: StoredPost, b: StoredPost) => sortAt(b).localeCompare(sortAt(a));

export const writePosts = (posts: StoredPost[]) =>
  writeJson(postsPath, [...posts].sort(byNewest));
export const writePending = (pending: PendingPost[]) =>
  writeJson(pendingPath, [...pending].sort(byNewest));
export const writeState = (state: CollectorState) => writeJson(statePath, state);

export const writePublic = (relPath: string, value: unknown) =>
  writeJson(join(PUBLIC_DIR, relPath), value);
