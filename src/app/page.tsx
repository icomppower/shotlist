import { Studio } from "@/components/Studio";
import { runnerMode } from "@/lib/runners";
import { demoClipsAreReal } from "@/lib/runners/demo";
import { SAMPLES } from "@/lib/samples";

// Read RUNNER at request time, not build time.
export const dynamic = "force-dynamic";

export default async function Home() {
  const mode = runnerMode();
  const real = (await Promise.all(SAMPLES.map((s) => demoClipsAreReal(s.id)))).every(Boolean);
  // Samples replay pre-made LTX clips in every mode, so offer them whenever those clips are real.
  return <Studio mode={mode} samples={mode === "demo" || real ? SAMPLES : []} demoReal={real} />;
}
