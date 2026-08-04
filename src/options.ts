import { getCurrentUser, signInWithGoogle, signOut } from "./lib/auth";
import { fetchMe } from "./lib/api";
import { PRICING_URL } from "./lib/config";

const accountStatus = document.getElementById("account-status") as HTMLElement;
const draftsStatus = document.getElementById("drafts-status") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const signInBtn = document.getElementById("sign-in") as HTMLButtonElement;
const signOutBtn = document.getElementById("sign-out") as HTMLButtonElement;
const buyBtn = document.getElementById("buy-drafts") as HTMLButtonElement;
const refreshBtn = document.getElementById("refresh-drafts") as HTMLButtonElement;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
  if (msg) window.setTimeout(() => (statusEl.textContent = ""), 2500);
}

async function refresh(): Promise<void> {
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

  try {
    const me = await fetchMe();
    draftsStatus.textContent = `${me.draftsRemaining} draft${me.draftsRemaining === 1 ? "" : "s"} remaining`;
  } catch (e) {
    draftsStatus.textContent = e instanceof Error ? e.message : "Could not load draft balance";
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
  chrome.tabs.create({ url: PRICING_URL });
});

refreshBtn.addEventListener("click", () => {
  void refresh();
});

void refresh();
