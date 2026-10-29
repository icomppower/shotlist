import { NextResponse } from "next/server";
import { HttpError, createProject } from "@/lib/server/projects";
import { toView } from "@/lib/server/pipeline";
import { errorResponse } from "@/lib/server/http";
import { runContext, userKeyFrom } from "@/lib/runners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const image = form.get("image");
    const sample = form.get("sample");
    if (!(image instanceof File) && typeof sample !== "string") throw new HttpError(400, "Missing image.");
    const project = await createProject(image instanceof File ? image : { sampleId: String(sample) });
    return NextResponse.json(await toView(project, runContext(userKeyFrom(req))), { status: 201 });
  } catch (err) {
    return errorResponse(err, userKeyFrom(req));
  }
}
