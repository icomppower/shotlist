import { NextResponse } from "next/server";
import { advance, submitStale, toView } from "@/lib/server/pipeline";
import { errorResponse, notFound } from "@/lib/server/http";
import { withProject } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Render every shot that is out of date, then re-stitch.
 * Body: { force?: string[] } — shot ids to re-take even if up to date.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { force?: unknown };
    const force = Array.isArray(body.force) ? body.force.filter((x): x is string => typeof x === "string") : [];
    const res = await withProject(id, async (p) => {
      const submitted = await submitStale(p, force);
      await advance(p); // stitches right away if only the order changed
      return submitted;
    });
    if (!res) return notFound();
    return NextResponse.json({ submitted: res.result, project: toView(res.project) });
  } catch (err) {
    return errorResponse(err);
  }
}
