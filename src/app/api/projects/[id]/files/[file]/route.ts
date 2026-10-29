import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { projectFile } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { mp4: "video/mp4", jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Serve project media with HTTP Range support (needed for video seeking). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  const ext = file.split(".").pop() ?? "";
  if (!TYPES[ext] || file === "project.json") return new Response("Not found", { status: 404 });
  let path: string;
  let size: number;
  try {
    path = projectFile(id, file);
    size = (await fs.stat(path)).size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers({
    "Content-Type": TYPES[ext],
    "Accept-Ranges": "bytes",
    // File names are content-keyed, so they never change once written.
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  if (new URL(req.url).searchParams.has("download")) {
    headers.set("Content-Disposition", `attachment; filename="${file}"`);
  }

  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers });
  }
  headers.set("Content-Length", String(size));
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { status: 200, headers });
}
