import { ApiError, createCheckout, fetchMe } from "./lib/api";
import { getCurrentUser, signInWithGoogle, signOut } from "./lib/auth";

const accountStatus = document.getElementById("account-status") as HTMLElement;
const draftsStatus = document.getElementById("drafts-status") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const signInBtn = document.getElementById("sign-in") as HTMLButtonElement;
const signOutBtn = document.getElementById("sign-out") as HTMLButtonElement;
const buyBtn = document.getElementById("buy-drafts") as HTMLButtonElement;
const refreshBtn = document.getElementById("refresh-drafts") as HTMLButtonElement;

const BUY_LABEL = "Buy drafts";
const REFRESH_LABEL = "Refresh balance";

function setStatus(msg: string): void {
  statusEl.textContent = msg;
  if (msg) window.setTimeout(() => (statusEl.textContent = ""), 2500);
}

function setBusy(busy: boolean, which: "refresh" | "buy" | "both"): void {
  const refresh = which === "refresh" || which === "both";
  const buy = which === "buy" || which === "both";

  if (refresh) {
    refreshBtn.disabled = busy;
    refreshBtn.textContent = busy ? "Refreshing…" : REFRESH_LABEL;
    refreshBtn.setAttribute("aria-busy", busy ? "true" : "false");
  }
  if (buy) {
    buyBtn.disabled = busy;
    buyBtn.textContent = busy ? "Opening checkout…" : BUY_LABEL;
    buyBtn.setAttribute("aria-busy", busy ? "true" : "false");
  }
}

async function refresh(opts?: { fromUserClick?: boolean }): Promise<void> {
  const fromClick = Boolean(opts?.fromUserClick);
  if (fromClick) {
    setBusy(true, "refresh");
    draftsStatus.textContent = "Fetching balance…";
  }

  try {
    const user = await getCurrentUser();
    if (!user) {
      accountStatus.textContent = "Not signed in.";
      draftsStatus.textContent = "";
      signInBtn.classList.remove("hidden");
      signOutBtn.classList.add("hidden");
      buyBtn.classList.add("hidden");
      refreshBtn.classList.add("hidden");
      return;
    }

    accountStatus.textContent = `Signed in as ${user.email ?? "your account"}`;
    signInBtn.classList.add("hidden");
    signOutBtn.classList.remove("hidden");
    buyBtn.classList.remove("hidden");
    refreshBtn.classList.remove("hidden");

    if (!fromClick) {
      draftsStatus.textContent = "Fetching balance…";
    }

    try {
      const me = await fetchMe();
      draftsStatus.textContent = `${me.draftsRemaining} draft${me.draftsRemaining === 1 ? "" : "s"} remaining`;
    } catch (e) {
      draftsStatus.textContent = e instanceof Error ? e.message : "Could not load draft balance";
    }
  } finally {
    if (fromClick) setBusy(false, "refresh");
  }
}

signInBtn.addEventListener("click", async () => {
  try {
    signInBtn.disabled = true;
    await signInWithGoogle();
    setStatus("Signed in.");
    await refresh();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : "Sign-in failed");
  } finally {
    signInBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", async () => {
  await signOut();
  setStatus("Signed out.");
  await refresh();
});

buyBtn.addEventListener("click", () => {
  void (async () => {
    setBusy(true, "buy");
    draftsStatus.textContent = "Preparing checkout…";
    try {
      // Intentional: confirm session before calling /api/checkout (avoids a slow 401 round-trip).
      const user = await getCurrentUser();
      if (!user) {
        setStatus("Sign in first.");
        draftsStatus.textContent = "";
        return;
      }

      draftsStatus.textContent = "Creating checkout…";
      const { url } = await createCheckout();
      draftsStatus.textContent = "Opening Polar…";
      chrome.tabs.create({ url });
      setStatus("Checkout opened in a new tab.");
      // Restore balance label after tab opens (don't leave "Opening Polar…" stuck).
      await refresh();
    } catch (e) {
      setStatus(e instanceof ApiError ? e.message : "Checkout failed");
      await refresh();
    } finally {
      setBusy(false, "buy");
    }
  })();
});

refreshBtn.addEventListener("click", () => {
  void refresh({ fromUserClick: true });
});

void refresh();
