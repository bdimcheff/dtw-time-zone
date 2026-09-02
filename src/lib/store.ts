import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { byNewest } from "./order.ts";
import type { StoredPost, PendingPost } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(ROOT, "data");
export const PUBLIC_DIR = join(ROOT, "public");
export const FUNCTIONS_DIR = join(ROOT, "functions");

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

export const readPosts = () => readJson<StoredPost[]>(postsPath, []);
export const readPending = () => readJson<PendingPost[]>(pendingPath, []);

/** URIs manually rejected; never re-enter pending. Hand-edited, or by apply-review.ts. */
export const readDenied = async () => new Set(await readJson<string[]>(deniedPath, []));

/**
 * Sorted and de-duplicated, because the file is a set and collect.ts reads it
 * back as one. Sorting is what keeps a hand edit and a scripted write producing
 * the same diff for the same content -- appending instead would make every
 * review session's diff depend on which route wrote the file last.
 */
export const writeDenied = (denied: Iterable<string>) =>
  writeJson(deniedPath, [...new Set(denied)].sort());

export const writePosts = (posts: StoredPost[]) =>
  writeJson(postsPath, [...posts].sort(byNewest));
export const writePending = (pending: PendingPost[]) =>
  writeJson(pendingPath, [...pending].sort(byNewest));

export const writePublic = (relPath: string, value: unknown) =>
  writeJson(join(PUBLIC_DIR, relPath), value);

/**
 * Remove a file from public/ if it is there. Hosting serves static content in
 * preference to rewrites, so a stale artifact of an earlier build shadows the
 * endpoint that replaced it -- and a deploy from that working tree restores the
 * old behaviour with nothing in the output to say so.
 */
export const unlinkPublic = (relPath: string) =>
  rm(join(PUBLIC_DIR, relPath), { force: true });

/** Deploy artifacts for the feed function, bundled with it rather than fetched. */
export const writeFunctions = (relPath: string, value: unknown) =>
  writeJson(join(FUNCTIONS_DIR, relPath), value);
