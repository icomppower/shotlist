import { getStorage, projectKey } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { mp4: "video/mp4", jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Serve project media (Range-aware, needed for video seeking). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  const ext = file.split(".").pop() ?? "";
  let key: string;
  try {
    if (!TYPES[ext]) throw new Error();
    key = projectKey(id, file);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const headers = new Headers({
    "Content-Type": TYPES[ext],
    // File names are content-keyed, so they never change once written.
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  if (new URL(req.url).searchParams.has("download")) {
    headers.set("Content-Disposition", `attachment; filename="${file}"`);
  }
  return getStorage().serve(key, req, headers);
}
