import type { ProjectView, Shot } from "./types";

export type EditableShot = Pick<Shot, "id" | "move" | "camera" | "duration" | "note" | "prompt">;

export class ApiError extends Error {
  constructor(message: string, public demo?: string) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; demo?: string };
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, body.demo);
  return body as T;
}

export const api = {
  create(image: File) {
    const form = new FormData();
    form.append("image", image);
    return fetch("/api/projects", { method: "POST", body: form }).then((r) => json<ProjectView>(r));
  },
  get(id: string) {
    return fetch(`/api/projects/${id}`, { cache: "no-store" }).then((r) => json<ProjectView>(r));
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
      headers: { "content-type": "application/json" },
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
