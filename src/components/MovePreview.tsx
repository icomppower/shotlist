"use client";

import type { CSSProperties } from "react";
import type { MoveId } from "@/lib/moves";

/** Tiny looping CSS preview of a camera move, played on the user's own image. */
export function MovePreview({ move, image, className = "" }: { move: MoveId; image?: string; className?: string }) {
  const bg: CSSProperties = image ? { backgroundImage: `url(${image})` } : {};
  return (
    <div className={`preview ${className}`} aria-hidden>
      <div className={`preview-layer mv-${move}`} style={bg} />
      {move === "dolly_zoom" && <div className="preview-layer mv-dolly_zoom-core" style={bg} />}
    </div>
  );
}
