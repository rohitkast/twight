import type { Goal } from "./lib/types";

const $ = (id: string) => document.getElementById(id)!;

const listEl = $("goal-list") as HTMLElement;
const formTitle = $("form-title") as HTMLElement;
const nameInput = $("goal-name") as HTMLInputElement;
const descInput = $("goal-desc") as HTMLTextAreaElement;
const saveBtn = $("goal-save") as HTMLButtonElement;
const statusEl = $("status") as HTMLElement;

let goals: Goal[] = [];
let editingId: string | null = null;

async function loadGoals(): Promise<void> {
  const res = (await chrome.storage.local.get("goals")) as { goals?: Goal[] };
  goals = res.goals ?? [];
  renderList();
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

function renderList(): void {
  if (goals.length === 0) {
    listEl.innerHTML = '<p class="muted">No goals yet. Add one below.</p>';
    return;
  }

  listEl.innerHTML = "";
  for (const g of goals) {
    const row = document.createElement("div");
    row.className = "goal-row";
    row.innerHTML = `
      <div class="goal-info">
        <strong>${escapeHtml(g.name)}</strong>
        <span class="desc muted">${escapeHtml(g.description)}</span>
      </div>
      <div class="goal-actions">
        <button class="btn-edit" data-id="${g.id}">Edit</button>
        <button class="btn-delete" data-id="${g.id}">Delete</button>
      </div>`;
    listEl.appendChild(row);
  }

  listEl.querySelectorAll<HTMLElement>(".btn-edit").forEach((btn) => {
    btn.addEventListener("click", () => startEdit(btn.dataset.id!));
  });
  listEl.querySelectorAll<HTMLElement>(".btn-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteGoal(btn.dataset.id!));
  });
}

function startEdit(id: string): void {
  const goal = goals.find((g) => g.id === id);
  if (!goal) return;
  editingId = id;
  nameInput.value = goal.name;
  descInput.value = goal.description;
  formTitle.textContent = "Edit goal";
  saveBtn.textContent = "Update goal";
  nameInput.focus();
}

function resetForm(): void {
  editingId = null;
  nameInput.value = "";
  descInput.value = "";
  formTitle.textContent = "Add a goal";
  saveBtn.textContent = "Add goal";
}

async function deleteGoal(id: string): Promise<void> {
  goals = goals.filter((g) => g.id !== id);
  await chrome.storage.local.set({ goals });
  const { activeGoalId } = (await chrome.storage.local.get("activeGoalId")) as {
    activeGoalId?: string;
  };
  if (activeGoalId === id) await chrome.storage.local.set({ activeGoalId: null });
  renderList();
  flash("Deleted.");
}

saveBtn.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  const description = descInput.value.trim();
  if (!name) { flash("Name is required.", true); return; }

  const id = editingId;
  if (id) {
    goals = goals.map((g) => (g.id === id ? { ...g, name, description } : g));
  } else {
    goals.push({ id: crypto.randomUUID(), name, description });
  }

  await chrome.storage.local.set({ goals });
  resetForm();
  renderList();
  flash(id ? "Updated." : "Goal added.");
});

function flash(msg: string, err = false): void {
  statusEl.textContent = msg;
  statusEl.className = err ? "status error" : "status ok";
  setTimeout(() => (statusEl.textContent = ""), 2000);
}

loadGoals();
