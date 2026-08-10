/**
 * Pricing page: Google sign-in (web) + authenticated Polar checkout.
 * Public Supabase keys — same values as src/lib/config.ts.
 */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm";

const SUPABASE_URL = "https://rcbnajyufootjbpncwxz.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjYm5hanl1Zm9vdGpicG5jd3h6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4MTYyMDUsImV4cCI6MjEwMTM5MjIwNX0.jC7yJrynfE2HiXUKHSLQV1eVF4ESUdQQIQEW593NdOA";

const API_BASE = window.location.origin;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    detectSessionInUrl: true,
    persistSession: true,
    flowType: "pkce",
  },
});

const signInBtn = document.getElementById("pricing-sign-in");
const buyBtn = document.getElementById("pricing-buy");
const accountLine = document.getElementById("pricing-account");
const statusLine = document.getElementById("pricing-status");

function setStatus(msg) {
  if (!statusLine) return;
  statusLine.textContent = msg;
  if (msg) window.setTimeout(() => (statusLine.textContent = ""), 4000);
}

function updateUi(session) {
  const signedIn = Boolean(session?.access_token);
  if (signInBtn) signInBtn.classList.toggle("hidden", signedIn);
  if (buyBtn) buyBtn.classList.toggle("hidden", !signedIn);
  if (accountLine) {
    if (signedIn && session.user?.email) {
      accountLine.textContent = `Signed in as ${session.user.email}`;
      accountLine.classList.remove("hidden");
    } else {
      accountLine.textContent = "";
      accountLine.classList.add("hidden");
    }
  }
}

async function refreshSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    setStatus(error.message);
    updateUi(null);
    return null;
  }
  updateUi(data.session);
  return data.session;
}

signInBtn?.addEventListener("click", async () => {
  try {
    signInBtn.disabled = true;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href.split("#")[0] },
    });
    if (error) setStatus(error.message);
  } finally {
    signInBtn.disabled = false;
  }
});

buyBtn?.addEventListener("click", async () => {
  const defaultLabel = buyBtn.textContent || "Buy 50 drafts — $5";
  try {
    buyBtn.disabled = true;
    buyBtn.setAttribute("aria-busy", "true");
    buyBtn.textContent = "Preparing checkout…";
    setStatus("");

    const session = await refreshSession();
    if (!session?.access_token) {
      setStatus("Sign in with Google first.");
      return;
    }

    buyBtn.textContent = "Creating checkout…";
    const res = await fetch(`${API_BASE}/api/checkout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(body.error || `Checkout failed (${res.status})`);
      return;
    }
    if (body.url) {
      buyBtn.textContent = "Redirecting…";
      window.location.href = body.url;
      return;
    }
    setStatus("Checkout did not return a URL.");
  } catch (e) {
    setStatus(e instanceof Error ? e.message : "Checkout failed");
  } finally {
    buyBtn.disabled = false;
    buyBtn.removeAttribute("aria-busy");
    buyBtn.textContent = defaultLabel;
  }
});

supabase.auth.onAuthStateChange((_event, session) => {
  updateUi(session);
});

void refreshSession();
