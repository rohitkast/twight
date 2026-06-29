import { getClient, buildSystemPrompt, streamReply, type ChatTurn } from "./lib/claude";
import type { RedditThread, ExtractResponse, Goal } from "./lib/types";

let thread: RedditThread | null = null;
let activeGoal: Goal | null = null;
let hasLoaded = false;
const history: ChatTurn[] = [];

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

async function trySendMessage(tabId: number): Promise<ExtractResponse | null> {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_THREAD" })) as ExtractResponse;
  } catch {
    return null;
  }
}

function init(): void {
  const chat = document.getElementById("chat") as HTMLElement;
  const input = document.getElementById("input") as HTMLTextAreaElement;
  const sendBtn = document.getElementById("send") as HTMLButtonElement;
  const loadBtn = document.getElementById("load") as HTMLButtonElement;
  const clearBtn = document.getElementById("clear") as HTMLButtonElement;
  const summary = document.getElementById("thread-summary") as HTMLElement;
  const goalSelect = document.getElementById("goal-select") as HTMLSelectElement | null;

  // ---- Bubbles ----

  function addBubble(role: "user" | "assistant", content = ""): HTMLElement {
    const el = document.createElement("div");
    el.className = `bubble ${role}`;
    el.textContent = content;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
    return el;
  }

  // ---- Goals ----

  async function loadGoals(): Promise<void> {
    if (!goalSelect) return;
    const { goals = [], activeGoalId = null } = (await chrome.storage.local.get([
      "goals",
      "activeGoalId",
    ])) as { goals?: Goal[]; activeGoalId?: string | null };

    goalSelect.innerHTML = '<option value="">No goal</option>';
    for (const g of goals) {
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = g.name;
      goalSelect.appendChild(opt);
    }
    goalSelect.value = activeGoalId ?? "";
    activeGoal = activeGoalId ? (goals.find((g) => g.id === activeGoalId) ?? null) : null;
  }

  document.getElementById("settings")?.addEventListener("click", () =>
    chrome.runtime.openOptionsPage(),
  );

  document.getElementById("manage-goals")?.addEventListener("click", () =>
    chrome.tabs.create({ url: chrome.runtime.getURL("goals.html") }),
  );

  goalSelect?.addEventListener("change", async () => {
    const { goals = [] } = (await chrome.storage.local.get("goals")) as { goals?: Goal[] };
    const id = goalSelect.value;
    activeGoal = id ? (goals.find((g) => g.id === id) ?? null) : null;
    await chrome.storage.local.set({ activeGoalId: id || null });
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.goals || changes.activeGoalId) loadGoals();
  });

  // ---- Thread loading ----

  async function doLoad(): Promise<void> {
    const btnLabel = hasLoaded ? "Reload thread" : "Load thread from page";
    loadBtn.textContent = "Loading…";
    loadBtn.disabled = true;
    summary.textContent = "Loading…";
    summary.className = "muted";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id || !/reddit\.com/.test(tab.url ?? "")) {
      summary.textContent = "Open a Reddit post tab, then try again.";
      loadBtn.textContent = btnLabel;
      loadBtn.disabled = false;
      return;
    }

    try {
      const resp = await trySendMessage(tab.id);

      if (!resp || (resp.ok && !resp.meta)) {
        summary.textContent = "Please refresh the Reddit tab (Ctrl+R) and try again.";
        loadBtn.textContent = btnLabel;
        loadBtn.disabled = false;
        return;
      }

      if (!resp.ok) {
        summary.textContent = `Couldn't read thread: ${resp.error}`;
        loadBtn.textContent = btnLabel;
        loadBtn.disabled = false;
        return;
      }

      thread = resp.thread;
      const { meta } = resp;

      let countMsg = `${thread.comments.length} comment${thread.comments.length !== 1 ? "s" : ""}`;
      if (meta.hasMore) countMsg += " (more available on page)";

      summary.innerHTML =
        `<strong>${escapeHtml(thread.title || "(untitled)")}</strong><br>` +
        `${escapeHtml(thread.subreddit)} · u/${escapeHtml(thread.author)} · ${countMsg}`;

      if (thread.comments.length === 0) {
        summary.innerHTML +=
          `<br><span class="warn">No comments captured — scroll down on the Reddit tab to load comments, then reload.</span>`;
      } else if (meta.partialLoad) {
        summary.innerHTML +=
          `<br><span class="warn">Some comments may not have loaded yet. Reload to retry.</span>`;
      }

      hasLoaded = true;
      loadBtn.textContent = "Reload thread";
    } catch (e) {
      summary.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      loadBtn.textContent = btnLabel;
    }

    loadBtn.disabled = false;
  }

  loadBtn.addEventListener("click", doLoad);

  clearBtn.addEventListener("click", () => {
    history.length = 0;
    thread = null;
    hasLoaded = false;
    chat.innerHTML = "";
    summary.textContent = "No thread loaded.";
    summary.className = "muted";
    loadBtn.textContent = "Load thread from page";
  });

  // ---- Chat ----

  async function send(): Promise<void> {
    const message = input.value.trim();
    if (!message) return;

    const { apiKey } = (await chrome.storage.local.get("apiKey")) as { apiKey?: string };
    if (!apiKey) {
      addBubble("assistant", "No API key set. Click ⚙ to add your Anthropic API key.");
      return;
    }

    input.value = "";
    addBubble("user", message);
    history.push({ role: "user", content: message });

    const out = addBubble("assistant", "…");
    sendBtn.disabled = true;

    try {
      const client = getClient(apiKey);
      const system = buildSystemPrompt(thread, activeGoal);
      let acc = "";
      for await (const delta of streamReply(client, system, history)) {
        acc += delta;
        out.textContent = acc;
        chat.scrollTop = chat.scrollHeight;
      }
      history.push({ role: "assistant", content: acc });
    } catch (e) {
      out.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });

  loadGoals();
}

// DOMContentLoaded may have already fired by the time this script executes
// (extension pages can behave differently). Handle both cases.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
