import "server-only";
import { NextResponse } from "next/server";
import { DemoLimitError } from "./limits";
import { HttpError } from "./projects";

export function errorResponse(err: unknown) {
  if (err instanceof DemoLimitError) return NextResponse.json({ error: err.message, demo: err.reason }, { status: 429 });
  if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error(err);
  return NextResponse.json({ error: err instanceof Error ? err.message : "Server error" }, { status: 500 });
}

export const notFound = () => NextResponse.json({ error: "Project not found" }, { status: 404 });
