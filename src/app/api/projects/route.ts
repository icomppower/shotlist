import { NextResponse } from "next/server";
import { HttpError, createProject } from "@/lib/server/projects";
import { toView } from "@/lib/server/pipeline";
import { errorResponse } from "@/lib/server/http";
import { runContext, userKeyFrom } from "@/lib/runners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    // A scene comes as JSON: multipart would rewrite its line breaks to CRLF,
    // and the scene must reach the model exactly as typed.
    const isJson = req.headers.get("content-type")?.includes("application/json");
    const form = isJson ? null : await req.formData();
    const body = isJson ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
    const image = form?.get("image");
    const sample = form?.get("sample") ?? body.sample;
    const scene = body.scene;
    let source: Parameters<typeof createProject>[0];
    if (image instanceof File) source = image;
    else if (typeof sample === "string") source = { sampleId: sample };
    else if (typeof scene === "string") source = { scene };
    else throw new HttpError(400, "Missing image or scene.");
    const project = await createProject(source);
    return NextResponse.json(await toView(project, runContext(userKeyFrom(req))), { status: 201 });
  } catch (err) {
    return errorResponse(err, userKeyFrom(req));
  }
}
