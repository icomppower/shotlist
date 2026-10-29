import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Project } from "../types";

/**
 * Local filesystem storage. Fine for `next dev` / `next start` on one machine.
 * On Vercel only /tmp is writable and it is per-instance, so a hosted build
 * needs shared storage (e.g. Vercel Blob) — that lands with the Comfy runner.
 */
export const DATA_DIR = process.env.SHOTLIST_DATA_DIR
  ? path.resolve(process.env.SHOTLIST_DATA_DIR)
  : process.env.VERCEL
    ? "/tmp/shotlist"
    : path.join(process.cwd(), ".data");

const ID_RE = /^[a-z0-9]{6,32}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function newId(bytes = 6): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function hash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 12);
}

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

export function projectDir(id: string): string {
  if (!isValidId(id)) throw new Error("invalid project id");
  return path.join(DATA_DIR, "projects", id);
}

export function projectFile(id: string, file: string): string {
  if (!FILE_RE.test(file)) throw new Error("invalid file name");
  return path.join(projectDir(id), file);
}

export async function readProject(id: string): Promise<Project | null> {
  if (!isValidId(id)) return null;
  try {
    const raw = await fs.readFile(path.join(projectDir(id), "project.json"), "utf8");
    return JSON.parse(raw) as Project;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeProject(p: Project): Promise<void> {
  const dir = projectDir(p.id);
  await fs.mkdir(dir, { recursive: true });
  p.updatedAt = Date.now();
  const tmp = path.join(dir, `project.json.${process.pid}.${newId(3)}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(p, null, 2));
  await fs.rename(tmp, path.join(dir, "project.json"));
}

// --- per-project mutex (in-process) -------------------------------------
// Survives Next dev hot reloads by living on globalThis.
const g = globalThis as unknown as { __shotlistLocks?: Map<string, Promise<unknown>> };
const locks = (g.__shotlistLocks ??= new Map());

/** Run a read-modify-write on a project without racing other requests. */
export async function withProject<T>(
  id: string,
  fn: (p: Project) => Promise<T> | T,
): Promise<{ project: Project; result: T } | null> {
  const prev = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  locks.set(id, chained);
  await prev;
  try {
    const project = await readProject(id);
    if (!project) return null;
    const result = await fn(project);
    await writeProject(project);
    return { project, result };
  } finally {
    release();
    if (locks.get(id) === chained) locks.delete(id);
  }
}
