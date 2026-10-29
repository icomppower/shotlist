import { NextResponse } from "next/server";
import { HttpError, createProject } from "@/lib/server/projects";
import { toView } from "@/lib/server/pipeline";
import { errorResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const image = form.get("image");
    if (!(image instanceof File)) throw new HttpError(400, "Missing image.");
    const project = await createProject(image);
    return NextResponse.json(await toView(project), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
