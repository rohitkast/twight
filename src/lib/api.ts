import type { ChatTurn } from "./claude";
import type { Goal, RedditThread } from "./types";
import { API_BASE_URL } from "./config";
import { getAccessToken, getInstallId, signInWithGoogle } from "./auth";

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

export interface CheckoutResponse {
  url: string;
}

/** Appended by /api/generate after a successful stream + draft deduction. */
export const DRAFTS_STREAM_FOOTER_RE = /<!--__TWIGHT_DRAFTS__:(\d+)-->$/;
const FOOTER_HOLD_CHARS = 40;

async function authHeaders(): Promise<HeadersInit> {
  const token = await getAccessToken();
  if (!token) throw new ApiError("Not signed in", 401, "unauthorized");
  const installId = await getInstallId();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Twight-Install-Id": installId,
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

/** Create a Polar checkout session tied to the signed-in user. */
export async function createCheckout(): Promise<CheckoutResponse> {
  const res = await fetch(`${API_BASE_URL}/api/checkout`, {
    method: "POST",
    headers: await authHeaders(),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(body.error || `Checkout failed (${res.status})`, res.status, body.code);
  }
  return (await res.json()) as CheckoutResponse;
}

export async function claimAnonymous(anonymousUserId: string): Promise<MeResponse> {
  const res = await fetch(`${API_BASE_URL}/api/auth/claim-anonymous`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ anonymousUserId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(body.error || `Claim failed (${res.status})`, res.status, body.code);
  }
  return (await res.json()) as MeResponse;
}

/** Google OAuth, then move leftover guest drafts onto that account (best-effort). */
export async function signInWithGoogleAndClaim(): Promise<{
  draftsRemaining: number | null;
  claimFailed: boolean;
}> {
  const { previousAnonymousUserId } = await signInWithGoogle();
  if (!previousAnonymousUserId) {
    return { draftsRemaining: null, claimFailed: false };
  }
  try {
    const me = await claimAnonymous(previousAnonymousUserId);
    return { draftsRemaining: me.draftsRemaining, claimFailed: false };
  } catch {
    return { draftsRemaining: null, claimFailed: true };
  }
}

export interface GeneratePromptLive {
  mode: "live";
  thread: RedditThread | null;
  goal: Goal | null;
  latestUserMessage?: string;
  context?: {
    summary?: string;
    includeRawThread?: boolean;
    requestThreadSummary?: boolean;
    includeComments?: boolean;
    /** Cap ITEM frames (1–10). Skip-unscoped generate uses 10. */
    maxItems?: number;
  };
}

export interface GeneratePromptFollowUp {
  mode: "followup";
  goal: Goal | null;
  followUp: {
    username: string;
    kind: string;
    subreddit: string;
    originalDraft: string;
    threadSummary: string;
  };
}

export interface GenerateRequest {
  history: ChatTurn[];
  /** Server builds the system prompt from this. Prefer over legacy `system`. */
  prompt: GeneratePromptLive | GeneratePromptFollowUp;
  /** @deprecated Ignored when `prompt` is present. Kept only for type compatibility. */
  system?: string;
}

export interface GenerateGoalRequest {
  name: string;
  product: string;
  intent: string;
  avoid?: string;
  /** When true, costs 1 draft. First generation is free. */
  isRegenerate: boolean;
}

export interface GenerateGoalResponse {
  playbook: string;
  targetTypes: string[];
  draftsRemaining: number;
  charged: boolean;
}

/** Generate (or regenerate) an outreach playbook for a goal. */
export async function generateGoalPlaybook(
  body: GenerateGoalRequest,
  signal?: AbortSignal,
): Promise<GenerateGoalResponse> {
  const res = await fetch(`${API_BASE_URL}/api/generate-goal`, {
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
      payload.error || `Goal playbook failed (${res.status})`,
      res.status,
      payload.code,
    );
  }

  return (await res.json()) as GenerateGoalResponse;
}

/**
 * Stream hosted generation. Yields text deltas.
 * On completion, the generator return value is the new drafts balance (if present).
 */
export async function* streamGenerate(
  body: GenerateRequest,
  signal?: AbortSignal,
): AsyncGenerator<string, number | undefined> {
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
  let tail = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    tail += decoder.decode(value, { stream: true });

    const holdBack = Math.min(tail.length, FOOTER_HOLD_CHARS);
    const safeLen = tail.length - holdBack;
    if (safeLen > 0) {
      yield tail.slice(0, safeLen);
      tail = tail.slice(safeLen);
    }
  }

  tail += decoder.decode();

  const footerMatch = tail.match(DRAFTS_STREAM_FOOTER_RE);
  if (footerMatch) {
    const balance = Number.parseInt(footerMatch[1], 10);
    tail = tail.slice(0, footerMatch.index);
    if (tail) yield tail;
    return Number.isFinite(balance) ? balance : undefined;
  }

  if (tail) yield tail;
  return undefined;
}
