import { NextResponse } from "next/server";
import { advance, submitStale, toView } from "@/lib/server/pipeline";
import { errorResponse, notFound } from "@/lib/server/http";
import { withProject } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Render every shot that is out of date, then re-stitch.
 * Body: { force?: string[]; only?: string[] } — ids to re-take even if up to
 * date, and (optionally) the only ids to submit, e.g. retrying one failed shot.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { force?: unknown; only?: unknown };
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
    const force = ids(body.force) ?? [];
    const only = ids(body.only);
    const res = await withProject(id, async (p) => {
      const submitted = await submitStale(p, { force, only });
      await advance(p); // stitches right away if only the order changed
      return submitted;
    });
    if (!res) return notFound();
    return NextResponse.json({ submitted: res.result, project: await toView(res.project) });
  } catch (err) {
    return errorResponse(err);
  }
}
