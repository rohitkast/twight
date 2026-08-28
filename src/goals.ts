import { ApiError, fetchMe, generateGoalPlaybook } from "./lib/api";
import { getAccessToken, getCurrentUser, ensureSession, signInWithGoogle } from "./lib/auth";
import type { Goal } from "./lib/types";
import { goalNeedsUpgrade } from "./lib/types";

const $ = (id: string) => document.getElementById(id)!;

const listEl = $("goal-list");
const formTitle = $("form-title");
const nameInput = $("goal-name") as HTMLInputElement;
const productInput = $("goal-product") as HTMLTextAreaElement;
const intentInput = $("goal-intent") as HTMLTextAreaElement;
const avoidInput = $("goal-avoid") as HTMLTextAreaElement;
const generateBtn = $("goal-generate") as HTMLButtonElement;
const regenerateBtn = $("goal-regenerate") as HTMLButtonElement;
const saveBtn = $("goal-save") as HTMLButtonElement;
const cancelBtn = $("goal-cancel") as HTMLButtonElement;
const statusEl = $("status");
const authStatus = $("auth-status");
const signInBtn = $("sign-in-btn") as HTMLButtonElement;
const upgradeBanner = $("upgrade-banner");
const playbookEmpty = $("playbook-empty");
const playbookLoading = $("playbook-loading");
const playbookText = $("playbook-text");
const targetsWrap = $("targets-wrap");
const targetChipsEl = $("target-chips");
const chipInput = $("chip-input") as HTMLInputElement;
const chipAddBtn = $("chip-add-btn") as HTMLButtonElement;

let goals: Goal[] = [];
let editingId: string | null = null;
let signedIn = false;
let draftsRemaining: number | null = null;

/** In-form playbook state (not saved until Save). */
let draftPlaybook = "";
let draftTargetTypes: string[] = [];
/** True once this form session has a playbook (next gen costs 1 draft). */
let hasPlaybookInForm = false;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

function previewDescription(g: Goal): string {
  if (g.product?.trim() || g.intent?.trim()) {
    return [g.product, g.intent].filter((x) => x?.trim()).join(" — ");
  }
  return g.description || "";
}

function buildDescription(): string {
  return [productInput.value.trim(), intentInput.value.trim()].filter(Boolean).join(" — ");
}

async function loadGoals(): Promise<void> {
  const res = (await chrome.storage.local.get("goals")) as { goals?: Goal[] };
  goals = res.goals ?? [];
  renderList();
}

function renderList(): void {
  if (goals.length === 0) {
    listEl.innerHTML = '<p class="muted text-sm">No goals yet. Add one below.</p>';
    return;
  }

  listEl.innerHTML = "";
  for (const g of goals) {
    const needsUpgrade = goalNeedsUpgrade(g);
    const row = document.createElement("div");
    row.className = `goal-row${needsUpgrade ? " needs-upgrade" : ""}`;

    const chips =
      g.targetTypes
        ?.slice(0, 3)
        .map((t) => `<span class="badge badge-soft badge-sm">${escapeHtml(t)}</span>`)
        .join("") ?? "";

    row.innerHTML = `
      <div class="goal-info">
        <div class="goal-title-row">
          <strong>${escapeHtml(g.name)}</strong>
          ${
            needsUpgrade
              ? `<span class="badge badge-warning badge-sm" title="Needs playbook upgrade">⚠ Upgrade</span>`
              : `<span class="badge badge-success badge-soft badge-sm">Ready</span>`
          }
        </div>
        <span class="desc muted">${escapeHtml(previewDescription(g))}</span>
        ${chips ? `<div class="goal-chips-preview">${chips}</div>` : ""}
      </div>
      <div class="goal-actions">
        <button type="button" class="btn btn-sm btn-ghost btn-edit" data-id="${g.id}">${
          needsUpgrade ? "Upgrade" : "Edit"
        }</button>
        <button type="button" class="btn btn-sm btn-ghost btn-delete text-error" data-id="${g.id}">Delete</button>
      </div>`;
    listEl.appendChild(row);
  }

  listEl.querySelectorAll<HTMLElement>(".btn-edit").forEach((btn) => {
    btn.addEventListener("click", () => startEdit(btn.dataset.id!));
  });
  listEl.querySelectorAll<HTMLElement>(".btn-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      void deleteGoal(btn.dataset.id!);
    });
  });
}

function setPlaybookUi(state: "empty" | "loading" | "ready"): void {
  playbookEmpty.classList.toggle("hidden", state !== "empty");
  playbookLoading.classList.toggle("hidden", state !== "loading");
  playbookText.classList.toggle("hidden", state !== "ready");
  targetsWrap.classList.toggle("hidden", state !== "ready");
}

function renderTargetChips(): void {
  targetChipsEl.innerHTML = "";
  for (const label of draftTargetTypes) {
    const chip = document.createElement("span");
    chip.className = "badge badge-primary badge-soft target-chip";
    const text = document.createElement("span");
    text.className = "chip-label";
    text.textContent = label;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn-ghost btn-xs btn-circle";
    remove.setAttribute("aria-label", `Remove ${label}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      draftTargetTypes = draftTargetTypes.filter((t) => t !== label);
      renderTargetChips();
      updateActionButtons();
    });
    chip.appendChild(text);
    chip.appendChild(remove);
    targetChipsEl.appendChild(chip);
  }
}

function applyPlaybookToForm(playbook: string, targetTypes: string[]): void {
  draftPlaybook = playbook;
  draftTargetTypes = [...targetTypes];
  hasPlaybookInForm = !!playbook.trim();
  playbookText.textContent = playbook;
  setPlaybookUi(hasPlaybookInForm ? "ready" : "empty");
  renderTargetChips();
  updateActionButtons();
}

function updateActionButtons(): void {
  const canGenerate = signedIn && !!nameInput.value.trim() && !!productInput.value.trim() && !!intentInput.value.trim();
  generateBtn.disabled = !canGenerate || hasPlaybookInForm;
  generateBtn.classList.toggle("hidden", hasPlaybookInForm);
  regenerateBtn.classList.toggle("hidden", !hasPlaybookInForm);
  regenerateBtn.disabled = !canGenerate || !signedIn;
  saveBtn.disabled = !hasPlaybookInForm || !nameInput.value.trim();
  cancelBtn.classList.toggle("hidden", !editingId);
}

function startEdit(id: string): void {
  const goal = goals.find((g) => g.id === id);
  if (!goal) return;
  editingId = id;
  nameInput.value = goal.name;
  productInput.value = goal.product ?? "";
  intentInput.value = goal.intent ?? "";
  avoidInput.value = goal.avoid ?? "";

  // Legacy goals: seed product/intent from description if missing
  if (!goal.product?.trim() && !goal.intent?.trim() && goal.description?.trim()) {
    productInput.value = goal.description;
  }

  const needs = goalNeedsUpgrade(goal);
  upgradeBanner.classList.toggle("hidden", !needs);
  formTitle.textContent = needs ? "Upgrade goal" : "Edit goal";
  saveBtn.textContent = needs ? "Save upgraded goal" : "Update goal";

  if (goal.playbook?.trim()) {
    applyPlaybookToForm(goal.playbook, goal.targetTypes ?? []);
  } else {
    draftPlaybook = "";
    draftTargetTypes = [];
    hasPlaybookInForm = false;
    playbookText.textContent = "";
    setPlaybookUi("empty");
    updateActionButtons();
  }

  nameInput.focus();
  formTitle.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetForm(): void {
  editingId = null;
  nameInput.value = "";
  productInput.value = "";
  intentInput.value = "";
  avoidInput.value = "";
  draftPlaybook = "";
  draftTargetTypes = [];
  hasPlaybookInForm = false;
  playbookText.textContent = "";
  setPlaybookUi("empty");
  upgradeBanner.classList.add("hidden");
  formTitle.textContent = "Add a goal";
  saveBtn.textContent = "Save goal";
  updateActionButtons();
}

async function deleteGoal(id: string): Promise<void> {
  goals = goals.filter((g) => g.id !== id);
  await chrome.storage.local.set({ goals });
  const { activeGoalId } = (await chrome.storage.local.get("activeGoalId")) as {
    activeGoalId?: string;
  };
  if (activeGoalId === id) await chrome.storage.local.set({ activeGoalId: null });
  if (editingId === id) resetForm();
  renderList();
  flash("Deleted.");
}

function addChipFromInput(): void {
  const label = chipInput.value.trim();
  if (!label) return;
  if (draftTargetTypes.some((t) => t.toLowerCase() === label.toLowerCase())) {
    chipInput.value = "";
    return;
  }
  if (draftTargetTypes.length >= 6) {
    flash("Max 6 target types.", true);
    return;
  }
  draftTargetTypes.push(label);
  chipInput.value = "";
  renderTargetChips();
  updateActionButtons();
}

async function runGenerate(isRegenerate: boolean): Promise<void> {
  if (!signedIn) {
    try {
      await ensureSession();
      await refreshAuth();
    } catch {
      flash("Could not start a guest session. Enable Anonymous sign-ins in Supabase.", true);
      return;
    }
  }
  if (!signedIn) {
    flash("Could not start a guest session.", true);
    return;
  }
  const name = nameInput.value.trim();
  const product = productInput.value.trim();
  const intent = intentInput.value.trim();
  const avoid = avoidInput.value.trim();
  if (!name || !product || !intent) {
    flash("Name, product, and intent are required.", true);
    return;
  }

  if (isRegenerate && draftsRemaining !== null && draftsRemaining <= 0) {
    flash("No drafts left — buy more to regenerate.", true);
    return;
  }

  generateBtn.disabled = true;
  regenerateBtn.disabled = true;
  saveBtn.disabled = true;
  setPlaybookUi("loading");
  flash(isRegenerate ? "Regenerating (1 draft)…" : "Generating playbook…");

  try {
    const res = await generateGoalPlaybook({
      name,
      product,
      intent,
      avoid: avoid || undefined,
      isRegenerate,
    });
    draftsRemaining = res.draftsRemaining;
    updateAuthLabel();
    applyPlaybookToForm(res.playbook, res.targetTypes);
    flash(
      res.charged
        ? `Playbook updated (−1 draft · ${res.draftsRemaining} left).`
        : "Playbook ready — free. Review chips, then save.",
    );
  } catch (e) {
    if (hasPlaybookInForm) setPlaybookUi("ready");
    else setPlaybookUi("empty");
    updateActionButtons();
    if (e instanceof ApiError && e.code === "insufficient_drafts") {
      draftsRemaining = 0;
      updateAuthLabel();
      flash("No drafts left. Buy more to regenerate.", true);
    } else if (e instanceof ApiError && e.status === 401) {
      signedIn = false;
      updateAuthUi();
      flash("Session expired — sign in again.", true);
    } else {
      flash(e instanceof Error ? e.message : String(e), true);
    }
  }
}

async function saveGoal(): Promise<void> {
  const name = nameInput.value.trim();
  const product = productInput.value.trim();
  const intent = intentInput.value.trim();
  const avoid = avoidInput.value.trim();
  if (!name) {
    flash("Name is required.", true);
    return;
  }
  if (!draftPlaybook.trim()) {
    flash("Generate a playbook before saving.", true);
    return;
  }

  const payload: Goal = {
    id: editingId ?? crypto.randomUUID(),
    name,
    description: buildDescription() || name,
    product,
    intent,
    avoid: avoid || undefined,
    playbook: draftPlaybook.trim(),
    targetTypes: [...draftTargetTypes],
    playbookGeneratedAt: Date.now(),
  };

  if (editingId) {
    goals = goals.map((g) => (g.id === editingId ? payload : g));
  } else {
    goals.push(payload);
  }

  await chrome.storage.local.set({ goals });
  const wasEdit = !!editingId;
  resetForm();
  renderList();
  flash(wasEdit ? "Goal updated." : "Goal saved.");
}

function flash(msg: string, err = false): void {
  statusEl.textContent = msg;
  statusEl.className = err ? "status error" : "status ok";
  if (!err) {
    window.setTimeout(() => {
      if (statusEl.textContent === msg) statusEl.textContent = "";
    }, 3500);
  }
}

function updateAuthLabel(): void {
  if (!signedIn) {
    authStatus.textContent = "Starting guest session\u2026";
    return;
  }
  if (draftsRemaining !== null) {
    authStatus.textContent = `Drafts · ${draftsRemaining} left`;
  } else {
    authStatus.textContent = "Ready";
  }
}

function updateAuthUi(): void {
  updateAuthLabel();
  updateActionButtons();
}

async function refreshAuth(): Promise<void> {
  try {
    await ensureSession();
  } catch {
    /* guest session optional on this page */
  }
  const token = await getAccessToken();
  const user = await getCurrentUser();
  signedIn = !!(token && user);
  signInBtn.classList.toggle("hidden", signedIn && !user?.is_anonymous);
  if (signedIn) {
    try {
      const me = await fetchMe();
      draftsRemaining = me.draftsRemaining;
    } catch {
      draftsRemaining = null;
    }
  } else {
    draftsRemaining = null;
  }
  updateAuthUi();
}

signInBtn.addEventListener("click", async () => {
  signInBtn.disabled = true;
  try {
    await signInWithGoogle();
    await refreshAuth();
    flash("Signed in.");
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e), true);
  } finally {
    signInBtn.disabled = false;
  }
});

generateBtn.addEventListener("click", () => {
  void runGenerate(false);
});
regenerateBtn.addEventListener("click", () => {
  void runGenerate(true);
});
saveBtn.addEventListener("click", () => {
  void saveGoal();
});
cancelBtn.addEventListener("click", () => resetForm());

chipAddBtn.addEventListener("click", () => addChipFromInput());
chipInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addChipFromInput();
  }
});

for (const el of [nameInput, productInput, intentInput, avoidInput]) {
  el.addEventListener("input", () => {
    // Editing source fields after a playbook: keep playbook but require regenerate for freshness
    updateActionButtons();
  });
}

void (async () => {
  await loadGoals();
  await refreshAuth();
  updateActionButtons();
})();
