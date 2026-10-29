import { Studio } from "@/components/Studio";
import { runnerMode } from "@/lib/runners";
import { demoClipsAreReal } from "@/lib/runners/demo";
import { SAMPLES } from "@/lib/samples";

// Read RUNNER at request time, not build time.
export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const mode = runnerMode();
  const real = await demoClipsAreReal(SAMPLES[0].id);
  return <Studio projectId={id} mode={mode} samples={mode === "demo" ? SAMPLES : []} demoReal={real} />;
}
