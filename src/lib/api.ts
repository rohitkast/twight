import type { ChatTurn } from "./claude";
import { API_BASE_URL } from "./config";
import { getAccessToken } from "./auth";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface MeResponse {
  email: string | null;
  draftsRemaining: number;
}

async function authHeaders(): Promise<HeadersInit> {
  const token = await getAccessToken();
  if (!token) throw new ApiError("Not signed in", 401, "unauthorized");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function fetchMe(): Promise<MeResponse> {
  const res = await fetch(`${API_BASE_URL}/api/me`, {
    method: "GET",
    headers: await authHeaders(),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(body.error || `Request failed (${res.status})`, res.status, body.code);
  }
  return (await res.json()) as MeResponse;
}

export interface GenerateRequest {
  system: string;
  history: ChatTurn[];
}

/**
 * Stream hosted generation. Yields text deltas (same shape as local streamReply).
 */
export async function* streamGenerate(
  body: GenerateRequest,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const res = await fetch(`${API_BASE_URL}/api/generate`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      draftsRemaining?: number;
    };
    throw new ApiError(
      payload.error || `Generate failed (${res.status})`,
      res.status,
      payload.code,
    );
  }

  if (!res.body) throw new ApiError("Empty response body", 500);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text) yield text;
  }
}
