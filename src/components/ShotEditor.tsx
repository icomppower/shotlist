"use client";

import { MANUAL_LIMITS, MOVES, MOVE_IDS, planPrompt, type ManualCamera, type Mode } from "@/lib/moves";
import type { EditableShot } from "@/lib/client";
import { MovePreview } from "./MovePreview";

/** Expanded shot: pick a move (cards) or set the camera, and edit the prompt. */
export function ShotEditor({
  shot,
  mode,
  imageUrl,
  canRetake,
  onChange,
  onRetake,
}: {
  shot: EditableShot;
  mode: Mode;
  imageUrl?: string;
  canRetake: boolean;
  onChange: (patch: Partial<EditableShot>) => void;
  onRetake: () => void;
}) {
  return (
    <div className="shot-editor">
      {mode === "manual" ? (
        <ManualControls camera={shot.camera} imageUrl={imageUrl} onChange={(camera) => onChange({ camera })} />
      ) : (
        <div className="move-grid" role="radiogroup" aria-label="Director move">
          {MOVE_IDS.map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={shot.move === m}
              className={`move-card ${shot.move === m ? "on" : ""}`}
              onClick={() => onChange({ move: m })}
            >
              <MovePreview move={m} image={imageUrl} />
              <span className="move-label">{MOVES[m].label}</span>
              <span className="move-blurb">{MOVES[m].blurb}</span>
            </button>
          ))}
        </div>
      )}

      {mode === "director" ? (
        <div className="field">
          <label htmlFor={`note-${shot.id}`}>Scene note <span className="muted">(optional)</span></label>
          <input
            id={`note-${shot.id}`}
            value={shot.note}
            placeholder="e.g. A detective under neon rain"
            onChange={(e) => onChange({ note: e.target.value })}
          />
          <p className="planned">
            <span className="sent-label">Planner prompt:</span> <code>{planPrompt(shot.move, shot.note)}</code>
          </p>
        </div>
      ) : (
        <div className="field">
          <label htmlFor={`prompt-${shot.id}`}>
            Prompt <span className="muted">— sent to LTX exactly as typed</span>
          </label>
          <textarea
            id={`prompt-${shot.id}`}
            rows={3}
            value={shot.prompt}
            spellCheck={false}
            placeholder="Describe the shot…"
            onChange={(e) => onChange({ prompt: e.target.value })}
          />
          {mode === "direct" && (
            <p className="muted small">The move only sets camera motion; it never edits this text.</p>
          )}
        </div>
      )}

      {canRetake && (
        <button className="ghost" onClick={onRetake}>↻ New take of this shot</button>
      )}
    </div>
  );
}

function ManualControls({
  camera,
  imageUrl,
  onChange,
}: {
  camera: ManualCamera;
  imageUrl?: string;
  onChange: (c: ManualCamera) => void;
}) {
  const { zoom, pan, roll } = MANUAL_LIMITS;
  const sliders: Array<[keyof ManualCamera, string, { min: number; max: number; step: number }, (v: number) => string]> = [
    ["zoomStart", "Zoom start", zoom, (v) => `${v.toFixed(2)}×`],
    ["zoomEnd", "Zoom end", zoom, (v) => `${v.toFixed(2)}×`],
    ["panX", "Pan X", pan, (v) => v.toFixed(2)],
    ["panY", "Pan Y", pan, (v) => v.toFixed(2)],
    ["roll", "Roll", roll, (v) => `${v}°`],
  ];
  return (
    <div className="manual">
      <MovePreview manual={camera} image={imageUrl} className="manual-preview" />
      <div className="sliders">
        {sliders.map(([key, label, lim, fmt]) => (
          <label key={key} className="slider">
            <span>{label}</span>
            <input
              type="range"
              min={lim.min}
              max={lim.max}
              step={lim.step}
              value={camera[key]}
              onChange={(e) => onChange({ ...camera, [key]: Number(e.target.value) })}
            />
            <output className="mono">{fmt(camera[key])}</output>
          </label>
        ))}
      </div>
    </div>
  );
}
