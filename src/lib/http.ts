import { USER_AGENT } from "../config.ts";

export interface JsonResponse {
  /** 0 when the host could not be reached at all. */
  status: number;
  type: string;
  body: unknown;
}

/**
 * GET a JSON endpoint without throwing. Both callers are checking whether a
 * deployment is healthy, so an unreachable host is a result to report rather
 * than an exception to handle.
 */
export async function getJson(url: string): Promise<JsonResponse> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  } catch (err) {
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
