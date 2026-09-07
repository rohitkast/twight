import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

const SESSION_KEY = "supabaseSession";
const INSTALL_ID_KEY = "twightInstallId";

/** Minimal fields we persist — chrome.storage JSON-clones these. */
interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  token_type?: string;
  user: User;
}

let client: SupabaseClient | null = null;
let authListenerAttached = false;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // We own persistence via chrome.storage.local (extension pages have no durable localStorage).
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  ensureAuthListener(client);
  return client;
}

function ensureAuthListener(supabase: SupabaseClient): void {
  if (authListenerAttached) return;
  authListenerAttached = true;
  // Keep chrome.storage in sync when the SDK refreshes JWTs in memory.
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") return;
    if (session?.access_token && session.refresh_token) {
      void persistSession(session);
    }
  });
}

function toStored(session: Session, fallbackRefresh?: string): StoredSession | null {
  const refresh_token = session.refresh_token || fallbackRefresh;
  if (!session.access_token || !refresh_token || !session.user) return null;
  return {
    access_token: session.access_token,
    refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    token_type: session.token_type,
    user: session.user,
  };
}

async function persistSession(session: Session, fallbackRefresh?: string): Promise<void> {
  const stored = toStored(session, fallbackRefresh);
  if (!stored) return;
  await chrome.storage.local.set({ [SESSION_KEY]: stored });
}

function sessionFromStored(raw: StoredSession): Session {
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    expires_at: raw.expires_at,
    expires_in: raw.expires_in ?? 3600,
    token_type: "bearer",
    user: raw.user,
  };
}

function isAccessTokenFresh(stored: StoredSession, skewSeconds = 60): boolean {
  if (!stored.expires_at) return true;
  return stored.expires_at * 1000 > Date.now() + skewSeconds * 1000;
}

function isInvalidGrant(error: { message?: string; status?: number } | null): boolean {
  if (!error) return false;
  if (error.status === 401 || error.status === 403) return true;
  const msg = (error.message || "").toLowerCase();
  return (
    msg.includes("invalid refresh") ||
    msg.includes("invalid_grant") ||
    (msg.includes("refresh token") &&
      (msg.includes("not found") || msg.includes("invalid") || msg.includes("expired")))
  );
}

async function readStored(): Promise<StoredSession | null> {
  const { [SESSION_KEY]: raw } = (await chrome.storage.local.get(SESSION_KEY)) as {
    [SESSION_KEY]?: StoredSession | null;
  };
  if (!raw?.access_token || !raw?.refresh_token || !raw.user) return null;
  return raw;
}

/**
 * Restore the Supabase session from chrome.storage.
 *
 * Important: supabase.auth.setSession() network-validates the JWT. In an extension
 * side panel that can fail on reopen (cold start / flaky network). We must NOT wipe
 * storage on those failures — that was forcing a manual Sign-in click every reopen
 * even though Google cookies still completed OAuth instantly.
 */
export async function getStoredSession(): Promise<Session | null> {
  const raw = await readStored();
  if (!raw) return null;

  const supabase = getSupabase();

  if (!isAccessTokenFresh(raw)) {
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: raw.refresh_token,
    });
    if (!error && data.session) {
      await persistSession(data.session, raw.refresh_token);
      return data.session;
    }
    if (isInvalidGrant(error)) {
      await chrome.storage.local.remove(SESSION_KEY);
      return null;
    }
    // Transient refresh failure — keep tokens; UI can still show signed-in via user cache.
    return null;
  }

  const { data, error } = await supabase.auth.setSession({
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
  });

  if (!error && data.session) {
    // setSession sometimes omits refresh_token in the returned session — preserve ours.
    await persistSession(data.session, raw.refresh_token);
    return data.session;
  }

  // setSession failed (often a getUser network check) but JWT is still fresh.
  // Return stored tokens so the side panel stays signed-in and API Bearer auth works.
  return sessionFromStored(raw);
}

export async function getAccessToken(): Promise<string | null> {
  const session = await getStoredSession();
  if (session?.access_token) return session.access_token;

  // Fresh token still on disk after a transient restore failure.
  const raw = await readStored();
  if (raw && isAccessTokenFresh(raw, 0)) return raw.access_token;
  return null;
}

export async function getInstallId(): Promise<string> {
  const { [INSTALL_ID_KEY]: existing } = (await chrome.storage.local.get(INSTALL_ID_KEY)) as {
    [INSTALL_ID_KEY]?: string;
  };
  if (typeof existing === "string" && existing.length >= 8) return existing;
  const created = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALL_ID_KEY]: created });
  return created;
}

export async function getCurrentUser(): Promise<User | null> {
  const session = await getStoredSession();
  if (session?.user) return session.user;

  // Optimistic UI: keep Sign-in hidden if we still have a stored identity + refresh token.
  const raw = await readStored();
  return raw?.user ?? null;
}

export function isAnonymousUser(user: User | null | undefined): boolean {
  if (!user) return false;
  if (user.is_anonymous === true) return true;
  return (user.identities || []).some((i) => i.provider === "anonymous");
}

let ensureInFlight: Promise<Session> | null = null;

/**
 * Restore a stored session, or create a guest (anonymous) Supabase user.
 * Enable Anonymous sign-ins in Supabase → Authentication → Providers.
 */
export async function ensureSession(): Promise<Session> {
  if (ensureInFlight) return ensureInFlight;
  const pending = (async () => {
    const existing = await getStoredSession();
    if (existing?.access_token) return existing;

    const raw = await readStored();
    if (raw && isAccessTokenFresh(raw, 0)) return sessionFromStored(raw);

    return signInAnonymously();
  })();
  ensureInFlight = pending;
  try {
    return await pending;
  } finally {
    if (ensureInFlight === pending) ensureInFlight = null;
  }
}

async function signInAnonymously(): Promise<Session> {
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.session) {
    throw new Error(
      error?.message ||
        "Could not start a guest session. Enable Anonymous sign-ins in the Supabase Auth dashboard.",
    );
  }
  await persistSession(data.session);
  return data.session;
}

/**
 * Google OAuth via chrome.identity.
 * Add the redirect from chrome.identity.getRedirectURL("auth") to Supabase
 * Auth → URL Configuration → Redirect URLs. Dev Mode ID example:
 *   https://knoflcakdhglkbfkickfpiepnphpbiii.chromiumapp.org/auth
 * Store ID:
 *   https://fpoaifndhjgaicoghecihpekgnhbiffb.chromiumapp.org/auth
 */
export async function signInWithGoogle(): Promise<{
  session: Session;
  previousAnonymousUserId: string | null;
}> {
  const previous = await getCurrentUser();
  const previousAnonymousUserId = isAnonymousUser(previous) ? previous!.id : null;

  const redirectUrl = chrome.identity.getRedirectURL("auth");
  const authUrl = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
  authUrl.searchParams.set("provider", "google");
  authUrl.searchParams.set("redirect_to", redirectUrl);
  // Without this, Google reuses the Chrome profile account and never shows a picker.
  authUrl.searchParams.set("prompt", "select_account");
  // launchWebAuthFlow caches a completed redirect for the same URL; bust that.
  authUrl.searchParams.set("nonce", crypto.randomUUID());

  const responseUrl = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      (redirectedTo) => {
        if (chrome.runtime.lastError || !redirectedTo) {
          reject(new Error(chrome.runtime.lastError?.message || "Sign-in cancelled"));
          return;
        }
        resolve(redirectedTo);
      },
    );
  });

  const parsed = new URL(responseUrl);
  const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const queryParams = parsed.searchParams;
  const access_token = hashParams.get("access_token") || queryParams.get("access_token");
  const refresh_token = hashParams.get("refresh_token") || queryParams.get("refresh_token");

  if (!access_token || !refresh_token) {
    throw new Error("Sign-in failed — no tokens returned. Check Supabase redirect URL settings.");
  }

  const supabase = getSupabase();
  const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
  if (error || !data.session) {
    throw new Error(error?.message || "Failed to establish session");
  }

  await persistSession(data.session, refresh_token);
  return { session: data.session, previousAnonymousUserId };
}

export async function signOut(): Promise<void> {
  const supabase = getSupabase();
  try {
    await supabase.auth.signOut();
  } catch {
    // ignore
  }
  // Do not remove twightInstallId — that is how a new guest is denied a second free 5.
  await chrome.storage.local.remove(SESSION_KEY);
}
