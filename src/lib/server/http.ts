import "server-only";
import { NextResponse } from "next/server";
import { redact } from "../runners";
import { DemoLimitError } from "./limits";
import { HttpError } from "./projects";

/** JSON error response. `secret` (a visitor's key) is scrubbed from anything returned or logged. */
export function errorResponse(err: unknown, secret?: string) {
  if (err instanceof DemoLimitError) return NextResponse.json({ error: err.message, demo: err.reason }, { status: 429 });
  if (err instanceof HttpError) return NextResponse.json({ error: redact(err.message, secret) }, { status: err.status });
  const message = redact(err instanceof Error ? err.message : "Server error", secret);
  console.error(`[shotlist] ${message}`);
  return NextResponse.json({ error: message }, { status: 500 });
}

export const notFound = () => NextResponse.json({ error: "Project not found" }, { status: 404 });
