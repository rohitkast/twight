const key = document.getElementById("key") as HTMLInputElement;
const geminiKey = document.getElementById("gemini-key") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLElement;

chrome.storage.local.get(["apiKey", "geminiApiKey"]).then((res) => {
  const r = res as { apiKey?: string; geminiApiKey?: string };
  if (r.apiKey) key.value = r.apiKey;
  if (r.geminiApiKey) geminiKey.value = r.geminiApiKey;
});

document.getElementById("save")!.addEventListener("click", async () => {
  await chrome.storage.local.set({
    apiKey: key.value.trim(),
    geminiApiKey: geminiKey.value.trim(),
  });
  statusEl.textContent = "Saved.";
  setTimeout(() => (statusEl.textContent = ""), 1500);
});
