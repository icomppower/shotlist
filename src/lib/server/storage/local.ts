import "server-only";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { StorageDriver } from "./types";

/** Files on local disk under `root`. The default; what `npm run dev` uses. */
export class LocalStorage implements StorageDriver {
  readonly name = "local";
  constructor(readonly root: string) {}

  private file(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("invalid storage key");
    return p;
  }

  async readJson<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(key), "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeJson(key: string, value: unknown) {
    const p = this.file(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2));
    await fs.rename(tmp, p);
  }

  async put(key: string, data: Buffer | { path: string }) {
    const p = this.file(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    if (Buffer.isBuffer(data)) await fs.writeFile(p, data);
    else await fs.rename(data.path, p).catch(() => fs.copyFile(data.path, p));
  }

  async localPath(key: string) {
    const p = this.file(key);
    await fs.access(p);
    return p;
  }

  async exists(key: string) {
    return fs.access(this.file(key)).then(() => true, () => false);
  }

  async delete(key: string) {
    await fs.rm(this.file(key), { force: true });
  }

  async list(prefix: string) {
    const base = prefix.replace(/\/+$/, "");
    const names = await fs.readdir(this.file(base)).catch(() => [] as string[]);
    return names.filter((n) => !n.endsWith(".tmp")).map((n) => `${base}/${n}`);
  }

  async serve(key: string, req: Request, headers: Headers) {
    let p: string;
    let size: number;
    try {
      p = this.file(key);
      size = (await fs.stat(p)).size;
    } catch {
      return new Response("Not found", { status: 404 });
    }
    headers.set("Accept-Ranges", "bytes");
    const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      const start = Math.max(0, range[1] ? Number(range[1]) : size - Number(range[2]));
      const end = Math.min(range[1] && range[2] ? Number(range[2]) : size - 1, size - 1);
      if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
      headers.set("Content-Length", String(end - start + 1));
      return new Response(Readable.toWeb(createReadStream(p, { start, end })) as ReadableStream, { status: 206, headers });
    }
    headers.set("Content-Length", String(size));
    return new Response(Readable.toWeb(createReadStream(p)) as ReadableStream, { status: 200, headers });
  }
}
