import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

const SESSION_KEY = "supabaseSession";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

export async function getStoredSession(): Promise<Session | null> {
  const { [SESSION_KEY]: raw } = (await chrome.storage.local.get(SESSION_KEY)) as {
    [SESSION_KEY]?: Session | null;
  };
  if (!raw?.access_token || !raw?.refresh_token) return null;

  const supabase = getSupabase();
  const { data, error } = await supabase.auth.setSession({
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
  });
  if (error || !data.session) {
    await chrome.storage.local.remove(SESSION_KEY);
    return null;
  }
  await chrome.storage.local.set({ [SESSION_KEY]: data.session });
  return data.session;
}

export async function getAccessToken(): Promise<string | null> {
  const session = await getStoredSession();
  return session?.access_token ?? null;
}

export async function getCurrentUser(): Promise<User | null> {
  const session = await getStoredSession();
  return session?.user ?? null;
}

/**
 * Google OAuth via chrome.identity.
 * Requires this redirect URL in Supabase Auth → URL Configuration → Redirect URLs:
 *   https://<extension-id>.chromiumapp.org/auth
 */
export async function signInWithGoogle(): Promise<Session> {
  const redirectUrl = chrome.identity.getRedirectURL("auth");
  const authUrl = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
  authUrl.searchParams.set("provider", "google");
  authUrl.searchParams.set("redirect_to", redirectUrl);

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

  await chrome.storage.local.set({ [SESSION_KEY]: data.session });
  return data.session;
}

export async function signOut(): Promise<void> {
  const supabase = getSupabase();
  try {
    await supabase.auth.signOut();
  } catch {
    // ignore
  }
  await chrome.storage.local.remove(SESSION_KEY);
}
