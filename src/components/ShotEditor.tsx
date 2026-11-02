"use client";

import { MOVES, MOVE_IDS } from "@/lib/moves";
import type { EditableShot } from "@/lib/client";
import { MovePreview } from "./MovePreview";

/** Expanded shot: pick a move (cards) and edit the prompt that goes to LTX. */
export function ShotEditor({
  shot,
  imageUrl,
  /** Shot 1 of a text-only project sends the scene itself; its prompt isn't edited here. */
  sceneShot,
  canRetake,
  onChange,
  onRetake,
}: {
  shot: EditableShot;
  imageUrl?: string;
  sceneShot: boolean;
  canRetake: boolean;
  onChange: (patch: Partial<EditableShot>) => void;
  onRetake: () => void;
}) {
  return (
    <div className="shot-editor">
      <div className="move-grid" role="radiogroup" aria-label="Camera move">
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

      {!sceneShot && (
        <div className="field">
          <label htmlFor={`prompt-${shot.id}`}>
            Sent to LTX <span className="muted">— exactly as typed</span>
          </label>
          <textarea
            id={`prompt-${shot.id}`}
            rows={3}
            value={shot.prompt}
            spellCheck={false}
            placeholder="Describe the shot…"
            onChange={(e) => onChange({ prompt: e.target.value })}
          />
        </div>
      )}

      {canRetake && (
        <button className="ghost" onClick={onRetake}>↻ New take of this shot</button>
      )}
    </div>
  );
}
