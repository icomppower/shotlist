"use client";

import { useRef, useState } from "react";
import type { ProjectView } from "@/lib/types";
import { fileUrl, type EditableShot } from "@/lib/client";
import type { Sample } from "@/lib/samples";

/**
 * The big frame: drop zone before upload, then the source still, the
 * per-shot progress strip while rendering, and the stitched result.
 */
export function Monitor({
  view,
  shots,
  imageUrl,
  busy,
  demo,
  samples,
  uploading,
  onUpload,
}: {
  view: ProjectView | null;
  shots: EditableShot[];
  imageUrl?: string;
  busy: boolean;
  /** Renders are blocked (daily cap / no key): play the sample instead. */
  demo: boolean;
  /** Demo mode: bundled sample images the visitor can start from. */
  samples: Sample[];
  uploading: boolean;
  onUpload: (f: File | { sample: string } | { scene: string }) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [copied, setCopied] = useState(false);
  // Demo mode pre-fills the bundled sample scene so Enter works right away.
  const [scene, setScene] = useState(() => samples.find((s) => s.scene)?.scene ?? "");

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) onUpload(f);
  };
  const fileInput = (
    <input
      ref={input}
      type="file"
      accept="image/jpeg,image/png,image/webp"
      hidden
      onChange={(e) => {
        pick(e.target.files);
        e.target.value = "";
      }}
    />
  );

  if (!view) {
    return (
      <div className="first-run">
        <h1>Turn one still into a directed sequence.</h1>
        <p className="muted">Drop an image, keep (or tweak) the four starter shots, hit Generate.</p>
        <button
          className={`dropzone ${over ? "over" : ""}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }}
          disabled={uploading}
        >
          <span className="step">1</span>
          <strong>{uploading ? "Uploading…" : "Drop an image"}</strong>
          <span className="muted">or click to choose · JPEG, PNG, WebP</span>
        </button>
        <input
          className="scene-field"
          placeholder="Describe a scene"
          aria-label="Describe a scene"
          value={scene}
          disabled={uploading}
          onChange={(e) => setScene(e.target.value)}
          onKeyDown={(e) => {
            // Sent exactly as typed: no trimming or rewriting.
            if (e.key === "Enter" && scene.trim()) onUpload({ scene });
          }}
        />
        {samples.filter((s) => s.image).map((s) => (
          <button key={s.id} className="sample-pick" onClick={() => onUpload({ sample: s.id })} disabled={uploading}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.image} alt="" />
            <span>Use the sample image · {s.label}</span>
          </button>
        ))}
        {fileInput}
      </div>
    );
  }

  const out = view.output;
  const video = out?.file ? fileUrl(view.id, out.file) : null;
  const updating = !!video && !view.outputFresh && busy;
  const statusById = new Map(view.shotsView.map((s) => [s.id, s]));
  const renderById = new Map(view.shots.map((s) => [s.id, s.render]));
  const stitching = out?.state === "stitching";
  const anyFailed = view.shots.some((s) => s.render?.state === "failed" && !statusById.get(s.id)?.inFlight);
  const inFlightStarts = view.shots.filter((s) => statusById.get(s.id)?.inFlight).map((s) => s.render!.submittedAt);
  const runStart = inFlightStarts.length ? Math.min(...inFlightStarts) : (out?.startedAt ?? 0);

  const share = async () => {
    const url = `${window.location.origin}/p/${view.id}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy this link", url);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="monitor">
      <div className="screen">
        {demo ? (
          <video key="sample" src="/sample-trailer.mp4" controls playsInline autoPlay muted loop />
        ) : video ? (
          <video key={video} src={video} controls playsInline autoPlay muted loop poster={imageUrl} />
        ) : imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="Source still" />
        ) : null}
        {demo && <span className="screen-tag">Demo limit reached — here’s a sample</span>}
        {!demo && updating && <span className="screen-tag">Updating…</span>}
        {!demo && !video && !busy && imageUrl && <span className="screen-tag subtle">Source still</span>}
      </div>

      {(busy || stitching || anyFailed) && (
        <div className="strip" aria-label="Render progress">
          {shots.map((s, i) => {
            const st = statusById.get(s.id);
            const r = renderById.get(s.id);
            const pct = st?.fresh ? 100 : st?.inFlight ? Math.round((r?.progress ?? 0) * 100) : 0;
            // Shots finished before this run started were reused, not re-rendered.
            const cached = st?.fresh && (r?.finishedAt ?? 0) < runStart;
            const failed = r?.state === "failed" && !st?.inFlight;
            const cls = failed ? "failed" : cached ? "cached" : st?.fresh ? "done" : st?.inFlight ? "running" : "idle";
            return (
              <div
                key={s.id}
                className={`tile ${cls}`}
                style={{ flexGrow: s.duration }}
                title={failed ? `Shot ${i + 1}: ${r?.error ?? ""}` : cached ? `Shot ${i + 1}: reused` : `Shot ${i + 1}: ${pct}%`}
              >
                <div className="fill" style={{ width: `${pct}%` }} />
                <span className="mono">{failed ? `${i + 1} · ${r?.failReason ?? "Render failed"}` : i + 1}</span>
              </div>
            );
          })}
          <div className={`tile stitch ${stitching ? "running" : ""}`} title="Stitch">
            <div className="fill" style={{ width: stitching ? "100%" : "0%" }} />
            <span className="mono">⧉</span>
          </div>
        </div>
      )}

      <div className="monitor-actions">
        {video && (
          <>
            <a className="btn primary" href={`${video}?download=1`} download>
              Download MP4
            </a>
            <button className="btn" onClick={share}>{copied ? "Link copied" : "Copy share link"}</button>
          </>
        )}
        <button className="btn ghost" onClick={() => input.current?.click()} disabled={uploading}>
          {uploading ? "Uploading…" : "Replace image"}
        </button>
        {out?.duration && <span className="muted mono small">{out.duration.toFixed(1)}s · 1280×704</span>}
        {fileInput}
      </div>
      {out?.state === "failed" && <p className="error-inline">Stitch failed: {out.error}</p>}
    </div>
  );
}
