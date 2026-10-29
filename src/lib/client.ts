import type { ProjectView, Shot } from "./types";

export type EditableShot = Pick<Shot, "id" | "move" | "camera" | "duration" | "note" | "prompt">;

export class ApiError extends Error {
  constructor(message: string, public demo?: string) {
    super(message);
  }
}

// The visitor's own Comfy key: kept in memory only (never localStorage), sent
// to our server as a header on each request, gone on reload.
let comfyKey = "";
export const setComfyKey = (k: string) => {
  comfyKey = k.trim();
};
const keyHeader = (): Record<string, string> => (comfyKey ? { "x-comfy-key": comfyKey } : {});

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; demo?: string };
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, body.demo);
  return body as T;
}

export const api = {
  create(source: File | { sample: string } | { scene: string }) {
    if (!(source instanceof File) && "scene" in source) {
      // JSON, not multipart: keeps the scene text byte-for-byte.
      return fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", ...keyHeader() },
        body: JSON.stringify({ scene: source.scene }),
      }).then((r) => json<ProjectView>(r));
    }
    const form = new FormData();
    if (source instanceof File) form.append("image", source);
    else form.append("sample", source.sample);
    return fetch("/api/projects", { method: "POST", body: form, headers: keyHeader() }).then((r) => json<ProjectView>(r));
  },
  get(id: string) {
    return fetch(`/api/projects/${id}`, { cache: "no-store", headers: keyHeader() }).then((r) => json<ProjectView>(r));
  },
  update(id: string, body: { mode?: string; shots?: EditableShot[] }) {
    return fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<ProjectView>(r));
  },
  generate(id: string, opts: { force?: string[]; only?: string[] } = {}) {
    return fetch(`/api/projects/${id}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...keyHeader() },
      body: JSON.stringify(opts),
    }).then((r) => json<{ submitted: string[]; project: ProjectView }>(r));
  },
};

export const fileUrl = (id: string, file: string) => `/api/projects/${id}/files/${file}`;

export function clientId(): string {
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const toEditable = (s: Shot): EditableShot => ({
  id: s.id, move: s.move, camera: s.camera, duration: s.duration, note: s.note, prompt: s.prompt,
});
