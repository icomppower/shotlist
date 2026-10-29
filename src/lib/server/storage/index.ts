import "server-only";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project } from "../../types";
import { BlobStorage } from "./blob";
import { LocalStorage } from "./local";
import type { StorageDriver } from "./types";

export type { StorageDriver } from "./types";

/** Root for STORAGE=local (and scratch space). */
export const DATA_DIR = process.env.SHOTLIST_DATA_DIR
  ? path.resolve(process.env.SHOTLIST_DATA_DIR)
  : process.env.VERCEL
    ? "/tmp/shotlist"
    : path.join(process.cwd(), ".data");

let driver: StorageDriver | undefined;

/** Pick the driver from STORAGE=local|blob (default: blob on Vercel when a Blob store is connected, else local). */
export function getStorage(): StorageDriver {
  if (driver) return driver;
  const fallback = process.env.VERCEL && process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "local";
  const kind = (process.env.STORAGE || fallback).trim().toLowerCase();
  if (kind === "local") driver = new LocalStorage(DATA_DIR);
  else if (kind === "blob") driver = new BlobStorage();
  else throw new Error(`Unknown STORAGE "${kind}" (expected local or blob)`);
  return driver;
}

/** Local working directory for ffmpeg output before it is stored. */
export async function scratchFile(name: string): Promise<string> {
  const dir = getStorage().name === "local" ? path.join(DATA_DIR, "tmp") : path.join(os.tmpdir(), "shotlist-tmp");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, `${newId(4)}-${name}`);
}

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

/** Storage key for a file inside a project. */
export function projectKey(id: string, file: string): string {
  if (!isValidId(id)) throw new Error("invalid project id");
  if (!FILE_RE.test(file)) throw new Error("invalid file name");
  return `projects/${id}/${file}`;
}

export async function readProject(id: string): Promise<Project | null> {
  if (!isValidId(id)) return null;
  return getStorage().readJson<Project>(projectKey(id, "project.json"));
}

export async function writeProject(p: Project): Promise<void> {
  p.updatedAt = Date.now();
  await getStorage().writeJson(projectKey(p.id, "project.json"), p);
}

// --- in-process locks ----------------------------------------------------
// Survive Next dev hot reloads by living on globalThis. (With STORAGE=blob on
// several serverless instances this is best-effort, not a distributed lock.)
const g = globalThis as unknown as { __shotlistLocks?: Map<string, Promise<unknown>> };
const locks = (g.__shotlistLocks ??= new Map());

export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  locks.set(name, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(name) === chained) locks.delete(name);
  }
}

/** Run a read-modify-write on a project without racing other requests. */
export async function withProject<T>(
  id: string,
  fn: (p: Project) => Promise<T> | T,
): Promise<{ project: Project; result: T } | null> {
  return withLock(`project:${id}`, async () => {
    const project = await readProject(id);
    if (!project) return null;
    const result = await fn(project);
    await writeProject(project);
    return { project, result };
  });
}
