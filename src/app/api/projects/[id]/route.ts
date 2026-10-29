import { NextResponse } from "next/server";
import { advance, toView } from "@/lib/server/pipeline";
import { applyUpdate } from "@/lib/server/projects";
import { errorResponse, notFound } from "@/lib/server/http";
import { withProject } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/** Read a project. Also advances its render jobs (poll-driven pipeline). */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const res = await withProject(id, advance);
    return res ? NextResponse.json(await toView(res.project)) : notFound();
  } catch (err) {
    return errorResponse(err);
  }
}

/** Update mode and/or the ordered shot list. */
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const res = await withProject(id, (p) => applyUpdate(p, body));
    return res ? NextResponse.json(await toView(res.project)) : notFound();
  } catch (err) {
    return errorResponse(err);
  }
}
