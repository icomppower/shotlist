"use client";

import type { CSSProperties } from "react";
import type { ManualCamera, MoveId } from "@/lib/moves";

/** Tiny looping CSS preview of a camera move, played on the user's own image. */
export function MovePreview({
  move,
  manual,
  image,
  className = "",
}: {
  move?: MoveId;
  manual?: ManualCamera;
  image?: string;
  className?: string;
}) {
  const bg: CSSProperties = image ? { backgroundImage: `url(${image})` } : {};
  if (manual) {
    const vars = {
      ...bg,
      "--z0": manual.zoomStart,
      "--z1": manual.zoomEnd,
      "--px": manual.panX,
      "--py": manual.panY,
      "--r": `${manual.roll}deg`,
    } as CSSProperties;
    return (
      <div className={`preview ${className}`} aria-hidden>
        <div className="preview-layer mv-manual" style={vars} />
      </div>
    );
  }
  return (
    <div className={`preview ${className}`} aria-hidden>
      <div className={`preview-layer mv-${move}`} style={bg} />
      {move === "dolly_zoom" && <div className="preview-layer mv-dolly_zoom-core" style={bg} />}
    </div>
  );
}
