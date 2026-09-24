/** Playground prompt presets. Custom presets persist in localStorage only —
 *  no D1 migration, no preset endpoint (decision: localStorage only).
 *  CODING_DEFAULT mirrors WORKLOADS.coding.prompt in src/benchmark/workloads.ts;
 *  test/playground.test.ts guards against drift. */

export interface PromptPreset {
  id: string;
  label: string;
  prompt: string;
  max_tokens: number;
}

// Mirror of WORKLOADS.coding.prompt — keep in sync (guarded by test).
export const CODING_DEFAULT =
  "Implement a Python function solve(nums, target) that returns indices of two numbers adding to target. Explain complexity and provide working code with a test case. Keep output under 400 tokens.";

export const BUILTIN_PRESETS: PromptPreset[] = [
  { id: "coding-default", label: "Coding default (benchmark)", prompt: CODING_DEFAULT, max_tokens: 256 },
  { id: "short-probe", label: "Short probe", prompt: "Say OK in 5 words.", max_tokens: 32 },
  {
    id: "reasoning-probe",
    label: "Reasoning probe",
    prompt: "Solve step by step: a train travels 60km in 1.5h, then 90km in 2h. What is the average speed? Show each step.",
    max_tokens: 256,
  },
  {
    id: "multilingual",
    label: "Multilingual",
    prompt: "Say hello in Hindi and Spanish, then write a one-line Python comment explaining a loop.",
    max_tokens: 128,
  },
  {
    id: "timeout-stress",
    label: "Timeout stress (long decode)",
    prompt: CODING_DEFAULT,
    max_tokens: 512,
  },
];

const STORAGE_KEY = "modelpulsex_playground_presets";

export function loadCustomPresets(): PromptPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (p): p is PromptPreset =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as PromptPreset).id === "string" &&
          typeof (p as PromptPreset).prompt === "string",
      )
      .slice(0, 50);
  } catch {
    return [];
  }
}

export function saveCustomPreset(p: PromptPreset): PromptPreset[] {
  const next = [
    p,
    ...loadCustomPresets().filter((x) => x.id !== p.id),
  ].slice(0, 50);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage full/blocked — keep in-memory only
  }
  return next;
}

export function deleteCustomPreset(id: string): PromptPreset[] {
  const next = loadCustomPresets().filter((x) => x.id !== id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}
