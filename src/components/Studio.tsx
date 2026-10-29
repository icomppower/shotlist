"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_MANUAL_CAMERA, MAX_DURATION, MIN_DURATION, MODES, MODE_LABELS, MOVES, planPrompt,
  type Mode, type MoveId,
} from "@/lib/moves";
import type { ProjectView } from "@/lib/types";
import { ApiError, api, clientId, fileUrl, setComfyKey, toEditable, type EditableShot } from "@/lib/client";
import { DEMO_T2V_MOVE, DEMO_T2V_SECONDS, type Sample } from "@/lib/samples";
import { MovePreview } from "./MovePreview";
import { ShotEditor } from "./ShotEditor";
import { Monitor } from "./Monitor";

const MAX_SHOTS = 12;
const DURATIONS = Array.from({ length: MAX_DURATION - MIN_DURATION + 1 }, (_, i) => MIN_DURATION + i);

export function Studio({
  projectId,
  mode: serverMode,
  samples,
  demoReal,
}: {
  projectId?: string;
  /** RUNNER on the server: mock | comfy | demo. */
  mode: string;
  /** Selectable sample images (demo mode only). */
  samples: Sample[];
  /** Demo clips are real LTX renders (not the mock placeholders). */
  demoReal: boolean;
}) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [shots, setShots] = useState<EditableShot[]>([]);
  const [mode, setMode] = useState<Mode>("director");
  const [openShot, setOpenShot] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"upload" | "generate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!projectId);
  const [demoHit, setDemoHit] = useState(false);
  // Bring-your-own-key: React state + client.ts memory only.
  const [userKey, setUserKey] = useState("");

  const id = view?.id;
  const latest = useRef({ shots, mode });
  latest.current = { shots, mode };

  // ---------------------------------------------------------------- loading
  const adopt = useCallback((v: ProjectView, editable = true) => {
    setView(v);
    if (editable) {
      setShots(v.shots.map(toEditable));
      setMode(v.mode);
    }
  }, []);

  useEffect(() => {
    if (!projectId) return;
    api.get(projectId)
      .then((v) => adopt(v))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId, adopt]);

  // ---------------------------------------------------------------- saving
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  const flush = useCallback(async (opts: { adoptEdits?: boolean } = {}) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!id) return;
    const run = saving.current.then(() =>
      api.update(id, latest.current).then((v) => adopt(v, !!opts.adoptEdits)),
    );
    saving.current = run.catch((e: Error) => setError(e.message));
    await saving.current;
  }, [id, adopt]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), 400);
  }, [flush]);

  const editShots = useCallback((fn: (s: EditableShot[]) => EditableShot[]) => {
    setShots((prev) => {
      const next = fn(prev);
      latest.current.shots = next;
      return next;
    });
    scheduleSave();
  }, [scheduleSave]);

  const patchShot = (sid: string, patch: Partial<EditableShot>) =>
    editShots((all) => all.map((s) => (s.id === sid ? { ...s, ...patch } : s)));

  const switchMode = async (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    latest.current.mode = m;
    // Server seeds Direct/Manual prompts from the planner; take them back.
    await flush({ adoptEdits: true });
  };

  // ---------------------------------------------------------------- polling
  const busy = !!view && (view.shotsView.some((s) => s.inFlight) || view.output?.state === "stitching");
  useEffect(() => {
    if (!busy || !id) return;
    const t = setTimeout(() => {
      api.get(id).then((v) => adopt(v, false)).catch(() => {});
    }, 900);
    return () => clearTimeout(t);
  }, [busy, id, view, adopt]);

  // ---------------------------------------------------------------- actions
  const upload = async (file: File | { sample: string } | { scene: string }) => {
    setError(null);
    setBusyAction("upload");
    try {
      const fresh = await api.create(file);
      // Replacing the image keeps the current shot list and mode.
      const v = view ? await api.update(fresh.id, latest.current) : fresh;
      adopt(v);
      window.history.replaceState(null, "", `/p/${v.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const generate = async (opts: { force?: string[]; only?: string[] } = {}) => {
    if (!id) return;
    setError(null);
    setBusyAction("generate");
    try {
      await flush();
      const res = await api.generate(id, opts);
      adopt(res.project, false);
    } catch (e) {
      if (e instanceof ApiError && e.demo) setDemoHit(true);
      else setError((e as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const addShot = () => {
    const move: MoveId = "slow_push_in";
    const s: EditableShot = {
      id: clientId(), move, camera: { ...DEFAULT_MANUAL_CAMERA }, duration: 4, note: "",
      prompt: mode === "director" ? "" : planPrompt(move, ""),
    };
    editShots((all) => [...all, s]);
    setOpenShot(s.id);
  };

  // ---------------------------------------------------------------- drag to reorder
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const [dragId, setDragId] = useState<string | null>(null);

  const onHandleDown = (e: React.PointerEvent, sid: string) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragId(sid);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (!dragId) return;
    const y = e.clientY;
    setShots((prev) => {
      const from = prev.findIndex((s) => s.id === dragId);
      let to = prev.length - 1;
      for (let i = 0; i < prev.length; i++) {
        const el = rowRefs.current.get(prev[i].id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (y < r.top + r.height / 2) {
          to = i;
          break;
        }
      }
      if (to === from || from < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      latest.current.shots = next;
      return next;
    });
  };
  const onHandleUp = () => {
    if (!dragId) return;
    setDragId(null);
    scheduleSave();
  };
  const nudge = (sid: string, dir: -1 | 1) =>
    editShots((all) => {
      const i = all.findIndex((s) => s.id === sid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= all.length) return all;
      const next = [...all];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  // ---------------------------------------------------------------- derived
  const statusById = useMemo(() => new Map(view?.shotsView.map((s) => [s.id, s])), [view]);
  const serverShot = useMemo(() => new Map(view?.shots.map((s) => [s.id, s])), [view]);
  // For a text-only project this is shot 1's last frame, once it exists.
  const imageUrl = view?.image ? fileUrl(view.id, view.image.file) : undefined;
  const total = shots.reduce((t, s) => t + s.duration, 0) - 0.5 * Math.max(shots.length - 1, 0);

  const stale = view ? view.shotsView.filter((s) => !s.fresh && !s.inFlight).length : 0;
  const hasOutput = !!view?.output?.file;
  let cta = "Generate video";
  // Demo mode without a key can only replay pre-made clips: a sample image,
  // preset moves, and the exact prompt each clip was rendered with.
  const demoMode = serverMode === "demo" && !userKey;
  const needsKey =
    demoMode &&
    (!view?.sample ||
      shots.some((s, i) =>
        mode === "manual"
          ? true
          : view.scene && i === 0
            ? s.move !== DEMO_T2V_MOVE || s.duration !== DEMO_T2V_SECONDS // shot 1 = the pre-made text-to-video shot
            : (mode === "director" ? planPrompt(s.move, s.note) : s.prompt) !== planPrompt(s.move, ""),
      ));

  // Blocked renders show the sample — but never over the user's own finished cut.
  const demo = (demoHit || !!view?.demo) && !view?.outputFresh;
  let ctaDisabled = !view || shots.length === 0 || busyAction !== null || demo;
  if (busy) {
    const done = view!.shotsView.filter((s) => s.fresh).length;
    cta = view!.output?.state === "stitching" && done === shots.length ? "Stitching…" : `Rendering ${done}/${shots.length}…`;
    ctaDisabled = true;
  } else if (view?.outputFresh) {
    cta = "Up to date";
    ctaDisabled = true;
  } else if (hasOutput && stale > 0) {
    cta = `Update video · re-render ${stale} shot${stale === 1 ? "" : "s"}`;
  } else if (hasOutput && stale === 0) {
    cta = "Re-stitch video";
  }

  if (needsKey) ctaDisabled = true;

  if (loading) return <main className="studio"><p className="muted pad">Loading…</p></main>;

  return (
    <main className={`studio ${view ? "has-project" : ""}`}>
      <header className="topbar">
        <a href="/" className="brand" aria-label="Shotlist home">
          <Logo />
          <span>Shotlist</span>
        </a>
        {view && (
          <div className="modes" role="tablist" aria-label="Mode">
            {MODES.map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={mode === m ? "on" : ""}
                onClick={() => void switchMode(m)}
                title={MODE_LABELS[m].hint}
              >
                {MODE_LABELS[m].label}
              </button>
            ))}
          </div>
        )}
        {view?.runner === "mock" && <span className="badge" title="RUNNER=mock: clips are faked locally">mock runner</span>}
      </header>

      {error && (
        <div className="error" role="alert">
          {error} <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <div className="layout">
        <section className="monitor-col" aria-label="Monitor">
          <Monitor
            view={view}
            shots={shots}
            imageUrl={imageUrl}
            busy={busy}
            demo={demo}
            uploading={busyAction === "upload"}
            onUpload={upload}
            samples={samples}
          />
        </section>

        {view && (
          <section className="shots-col" aria-label="Shot list">
            <div className="step-head">
              <h2><span className="step">2</span> Shot list</h2>
              <span className="muted mono">{shots.length} shots · {total.toFixed(1)}s</span>
            </div>
            <p className="muted hint">{MODE_LABELS[mode].hint} Drag ⋮⋮ to reorder, tap a shot to change it.</p>

            <ol className="shots">
              {shots.map((s, i) => {
                const st = statusById.get(s.id);
                const r = serverShot.get(s.id)?.render;
                const open = openShot === s.id;
                return (
                  <li
                    key={s.id}
                    ref={(el) => {
                      if (el) rowRefs.current.set(s.id, el);
                      else rowRefs.current.delete(s.id);
                    }}
                    className={`shot ${open ? "open" : ""} ${dragId === s.id ? "dragging" : ""}`}
                  >
                    <div className="shot-row">
                      <button
                        className="handle"
                        aria-label={`Drag to reorder shot ${i + 1}`}
                        onPointerDown={(e) => onHandleDown(e, s.id)}
                        onPointerMove={onHandleMove}
                        onPointerUp={onHandleUp}
                        onPointerCancel={onHandleUp}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowUp") { e.preventDefault(); nudge(s.id, -1); }
                          if (e.key === "ArrowDown") { e.preventDefault(); nudge(s.id, 1); }
                        }}
                      >
                        ⋮⋮
                      </button>
                      <button className="shot-main" onClick={() => setOpenShot(open ? null : s.id)} aria-expanded={open}>
                        <MovePreview
                          move={s.move}
                          manual={mode === "manual" ? s.camera : undefined}
                          image={imageUrl}
                          className="thumb"
                        />
                        <span className="shot-title">
                          <span className="mono muted">#{i + 1}</span>{" "}
                          {mode === "manual" ? `${s.camera.zoomStart.toFixed(2)}→${s.camera.zoomEnd.toFixed(2)}×` : MOVES[s.move].label}
                        </span>
                        <ShotStatus fresh={st?.fresh} inFlight={st?.inFlight} progress={r?.progress} failed={r?.state === "failed"} rendered={!!r} />
                      </button>
                      <div className="durations" role="radiogroup" aria-label="Duration">
                        {DURATIONS.map((d) => (
                          <button
                            key={d}
                            role="radio"
                            aria-checked={s.duration === d}
                            className={s.duration === d ? "on" : ""}
                            onClick={() => patchShot(s.id, { duration: d })}
                          >
                            {d}s
                          </button>
                        ))}
                      </div>
                      <button
                        className="icon-btn"
                        aria-label={`Remove shot ${i + 1}`}
                        disabled={shots.length <= 1}
                        onClick={() => editShots((all) => all.filter((x) => x.id !== s.id))}
                      >
                        ×
                      </button>
                    </div>

                    {open && (
                      <ShotEditor
                        shot={s}
                        mode={mode}
                        imageUrl={imageUrl}
                        canRetake={!!st?.fresh && !busy}
                        onChange={(patch) => patchShot(s.id, patch)}
                        onRetake={() => void generate({ force: [s.id], only: [s.id] })}
                      />
                    )}

                    {r?.state === "failed" && st && !st.inFlight && (
                      <p className="failed-line" role="alert">
                        <span>{r.failReason ?? "Render failed"} — the video won’t stitch until this shot is fixed.</span>
                        <button
                          className="btn small-btn"
                          disabled={busyAction !== null || demo}
                          onClick={() => void generate({ only: [s.id] })}
                        >
                          Edit &amp; retry
                        </button>
                      </p>
                    )}

                    {r && (
                      <p className="sent">
                        <span className="sent-label">Sent to LTX:</span>{" "}
                        <code>{r.sentPrompt === "" ? "(empty prompt)" : r.sentPrompt}</code>
                        {st && !st.fresh && !st.inFlight && r.state !== "failed" && <span className="changed"> · changed, re-sends on next generate</span>}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>

            {shots.length < MAX_SHOTS && (
              <button className="add-shot" onClick={addShot}>+ Add shot</button>
            )}

            <div className="generate-bar">
              <div className="step-head compact">
                <h2><span className="step">3</span> Generate</h2>
                {view.creditsUsed > 0 && <span className="muted mono">{view.creditsUsed} credits used</span>}
              </div>
              {serverMode === "demo" && (
                <>
                  <input
                    className="key-field"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Comfy API key (renders on your credits)"
                    placeholder="Comfy API key (renders on your credits)"
                    value={userKey}
                    onChange={(e) => {
                      setUserKey(e.target.value);
                      setComfyKey(e.target.value);
                    }}
                  />
                  {demoMode && (
                    <p className="muted small demo-line">
                      {needsKey
                        ? "Paste a Comfy key to render your own."
                        : demoReal
                          ? "Demo mode — real LTX renders, pre-made."
                          : "Demo mode — placeholder clips until the real LTX renders are added."}
                    </p>
                  )}
                </>
              )}
              <button className="cta" disabled={ctaDisabled} onClick={() => void generate()}>
                {busyAction === "generate" ? "Starting…" : cta}
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function ShotStatus(p: { fresh?: boolean; inFlight?: boolean; progress?: number; failed?: boolean; rendered: boolean }) {
  if (p.inFlight) return <span className="status running">{Math.round((p.progress ?? 0) * 100)}%</span>;
  if (p.fresh) return <span className="status done" title="Rendered">✓</span>;
  if (p.failed) return <span className="status failed">failed</span>;
  if (p.rendered) return <span className="status stale">changed</span>;
  return null;
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <rect x="2.5" y="8" width="19" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 8 L5.5 3.2 L21 3.2 L21 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M8 3.4 L6.4 8 M13 3.4 L11.4 8 M18 3.4 L16.4 8" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17.5" cy="14.5" r="2.2" fill="var(--rec)" />
    </svg>
  );
}
