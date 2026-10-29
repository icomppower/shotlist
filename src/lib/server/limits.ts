import "server-only";
import { getStorage, withLock } from "./storage";

/** Global renders-per-UTC-day cap that protects a public live link. */
export function dailyShotCap(): number {
  const n = Number(process.env.DAILY_SHOT_CAP ?? 60);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 60;
}

const usageKey = () => `usage/${new Date().toISOString().slice(0, 10)}.json`;

export async function shotsUsedToday(): Promise<number> {
  return (await getStorage().readJson<{ shots: number }>(usageKey()))?.shots ?? 0;
}

/** Count `n` renders against today's cap. False (and nothing counted) if it would exceed it. */
export async function reserveShots(n: number): Promise<boolean> {
  if (n === 0) return true;
  return withLock("usage", async () => {
    const used = await shotsUsedToday();
    if (used + n > dailyShotCap()) return false;
    await getStorage().writeJson(usageKey(), { shots: used + n });
    return true;
  });
}

export type DemoReason = "cap" | "no-key";

/** Why the app is showing the sample instead of rendering, if it is. */
export async function demoReason(): Promise<DemoReason | null> {
  if ((process.env.RUNNER ?? "mock").trim().toLowerCase() === "comfy" && !process.env.COMFY_API_KEY) return "no-key";
  return (await shotsUsedToday()) >= dailyShotCap() ? "cap" : null;
}

export class DemoLimitError extends Error {
  constructor(public reason: DemoReason) {
    super("Demo limit reached");
  }
}
