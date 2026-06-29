const key = document.getElementById("key") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLElement;

chrome.storage.local.get("apiKey").then((res) => {
  const apiKey = (res as { apiKey?: string }).apiKey;
  if (apiKey) key.value = apiKey;
});

document.getElementById("save")!.addEventListener("click", async () => {
  await chrome.storage.local.set({ apiKey: key.value.trim() });
  statusEl.textContent = "Saved.";
  setTimeout(() => (statusEl.textContent = ""), 1500);
});
