import { USER_AGENT } from "../config.ts";

export interface JsonResponse {
  /** 0 when the host could not be reached at all. */
  status: number;
  type: string;
  body: unknown;
}

/**
 * The AppView aborts a feed generator at 10s with no retries, so a response
 * slower than this is already a broken feed. Bounded at all because an
 * unbounded fetch against a host that accepts a connection and then stalls
 * hangs the whole job until its 45-minute timeout, which reads in the Actions
 * UI as a wedged run rather than a failed check.
 */
const TIMEOUT_MS = 10_000;

/**
 * GET a JSON endpoint without throwing. Both callers are checking whether a
 * deployment is healthy, so an unreachable host is a result to report rather
 * than an exception to handle.
 */
export async function getJson(url: string): Promise<JsonResponse> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if ((err as Error)?.name === "TimeoutError") {
      return { status: 0, type: `unreachable (no response in ${TIMEOUT_MS / 1000}s)`, body: null };
    }
    const cause = (err as { cause?: { code?: string } })?.cause?.code ?? "network error";
    return { status: 0, type: `unreachable (${cause})`, body: null };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body; the content-type check reports it */
  }
  return { status: res.status, type: res.headers.get("content-type") ?? "", body };
}

export const isJson = (type: string): boolean => type.includes("application/json");
