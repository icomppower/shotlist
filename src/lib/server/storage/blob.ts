import "server-only";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { BlobNotFoundError, del, get, head, list, put } from "@vercel/blob";
import type { StorageDriver } from "./types";

/**
 * Vercel Blob (private store), authenticated with BLOB_READ_WRITE_TOKEN.
 * Media is streamed through the app, so blobs never need to be public.
 * Not exercised by the test suite (no token in CI) — see README.
 */
export class BlobStorage implements StorageDriver {
  readonly name = "blob";
  private readonly token: string;
  private readonly cacheDir = path.join(os.tmpdir(), "shotlist-blob-cache");

  constructor(token = process.env.BLOB_READ_WRITE_TOKEN) {
    if (!token) throw new Error("STORAGE=blob needs BLOB_READ_WRITE_TOKEN");
    this.token = token;
  }

  private opts() {
    return { access: "private" as const, token: this.token };
  }

  async readJson<T>(key: string): Promise<T | null> {
    // Mutable JSON: bypass the CDN cache so reads see the latest write.
    const res = await get(key, { ...this.opts(), useCache: false }).catch((e) => {
      if (e instanceof BlobNotFoundError) return null;
      throw e;
    });
    if (!res || res.statusCode !== 200) return null;
    return JSON.parse(await new Response(res.stream).text()) as T;
  }

  async writeJson(key: string, value: unknown) {
    await put(key, JSON.stringify(value, null, 2), {
      ...this.opts(),
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    });
  }

  async put(key: string, data: Buffer | { path: string }, contentType: string) {
    const body = Buffer.isBuffer(data) ? data : createReadStream(data.path);
    await put(key, body, {
      ...this.opts(),
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      multipart: !Buffer.isBuffer(data),
    });
    if (!Buffer.isBuffer(data)) {
      // Keep the local copy as cache so ffmpeg can use it without a download.
      const cached = path.join(this.cacheDir, key);
      await fs.mkdir(path.dirname(cached), { recursive: true });
      await fs.rename(data.path, cached).catch(() => fs.copyFile(data.path, cached));
    }
  }

  /** Media keys are content-addressed (never rewritten), so a local cache is safe. */
  async localPath(key: string) {
    const cached = path.join(this.cacheDir, key);
    if (await fs.access(cached).then(() => true, () => false)) return cached;
    const res = await get(key, this.opts());
    if (!res || res.statusCode !== 200) throw new Error(`blob not found: ${key}`);
    await fs.mkdir(path.dirname(cached), { recursive: true });
    const tmp = `${cached}.${process.pid}.part`;
    await fs.writeFile(tmp, Readable.fromWeb(res.stream as import("node:stream/web").ReadableStream));
    await fs.rename(tmp, cached);
    return cached;
  }

  async exists(key: string) {
    try {
      await head(key, { token: this.token });
      return true;
    } catch (e) {
      if (e instanceof BlobNotFoundError) return false;
      throw e;
    }
  }

  async delete(key: string) {
    await del(key, { token: this.token }).catch(() => {});
  }

  async list(prefix: string) {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: prefix.replace(/\/?$/, "/"), cursor, token: this.token });
      keys.push(...page.blobs.map((b) => b.pathname));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }

  async serve(key: string, req: Request, headers: Headers) {
    const range = req.headers.get("range");
    const res = await get(key, { ...this.opts(), headers: range ? { range } : undefined }).catch(() => null);
    if (!res || !res.stream) return new Response("Not found", { status: 404 });
    for (const h of ["content-length", "content-range", "accept-ranges", "etag"]) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    const status = res.headers.get("content-range") ? 206 : 200;
    return new Response(res.stream, { status, headers });
  }
}
