// Director-mode vibe planner. Deterministic, no LLM, no key: works in demo
// mode and on the public link. Turns "horror trailer" into a shot list of
// [{ move, duration, shot_note }]. The user's own words are never rewritten —
// the final prompt is assembled in code as `note + " " + shot_note`.

import { MOVES, type MoveId } from "./moves";

export interface PlannedShot {
  move: MoveId;
  duration: number;
  shot_note: string;
}

type Beat = [MoveId, number, string];

const cam = (m: MoveId) => MOVES[m].cameraPrompt;

const GENRES: Array<{ match: RegExp; beats: Beat[] }> = [
  {
    match: /horror|scary|creepy|haunt|nightmare|dread/i,
    beats: [
      ["slow_push_in", 5, "dread builds in dim flickering light"],
      ["whip_pan", 3, "something moves at the edge of frame"],
      ["crash_zoom", 3, "a sudden terrifying reveal, harsh contrast"],
      ["crane_reveal", 5, "the full horror laid bare, cold desaturated grade"],
    ],
  },
  {
    match: /action|chase|fight|explosive|blockbuster|war/i,
    beats: [
      ["fpv_dive", 4, "high-energy opening, debris in the air"],
      ["whip_pan", 3, "impact hits, sparks and dust"],
      ["bullet_orbit", 4, "the hero mid-strike, frozen moment"],
      ["crash_zoom", 3, "final blow, lens flare and shake"],
    ],
  },
  {
    match: /roman|love|wedding|tender|intimate/i,
    beats: [
      ["slow_push_in", 6, "soft golden light, tender and quiet"],
      ["crane_reveal", 5, "warm wide reveal, gentle breeze"],
      ["dolly_zoom", 4, "a breath held, the world falls away"],
      ["slow_push_in", 5, "close and warm, shallow focus"],
    ],
  },
  {
    match: /document|nature|travel|wildlife|planet|calm|serene/i,
    beats: [
      ["crane_reveal", 6, "sweeping establishing shot, natural light"],
      ["slow_push_in", 5, "patient observational detail"],
      ["fpv_dive", 5, "soaring over the landscape"],
      ["slow_push_in", 5, "quiet closing frame, soft haze"],
    ],
  },
  {
    match: /commercial|product|ad\b|advert|brand|luxury|launch/i,
    beats: [
      ["slow_push_in", 4, "clean studio light, premium finish"],
      ["bullet_orbit", 4, "the product turns, highlights glide"],
      ["crash_zoom", 3, "hero detail, crisp and sharp"],
      ["crane_reveal", 4, "final wide beauty shot, polished"],
    ],
  },
  {
    match: /music|concert|dance|club|neon|synth|rave/i,
    beats: [
      ["crash_zoom", 3, "on the beat, strobing color"],
      ["whip_pan", 3, "rhythmic cut, neon streaks"],
      ["bullet_orbit", 4, "frozen pose in colored haze"],
      ["fpv_dive", 4, "diving through the lights"],
    ],
  },
  {
    match: /sci-?fi|space|cyber|future|robot|alien/i,
    beats: [
      ["crane_reveal", 5, "vast futuristic scale, cold blue light"],
      ["fpv_dive", 4, "racing through the structure"],
      ["dolly_zoom", 4, "unsettling perspective shift, holographic glow"],
      ["slow_push_in", 5, "ominous close approach, humming machinery"],
    ],
  },
  {
    match: /noir|thriller|mystery|detective|crime|suspense/i,
    beats: [
      ["slow_push_in", 5, "rain-slick shadows, hard side light"],
      ["dolly_zoom", 4, "a realization lands, the room tilts"],
      ["whip_pan", 3, "a glance over the shoulder"],
      ["crash_zoom", 3, "the clue in sharp focus, smoke drifting"],
    ],
  },
  {
    match: /comed|funny|silly|goofy|quirky/i,
    beats: [
      ["slow_push_in", 4, "deadpan stillness, bright even light"],
      ["crash_zoom", 3, "comic overreaction, abrupt and punchy"],
      ["whip_pan", 3, "double-take to the side"],
      ["crane_reveal", 4, "the absurd whole picture revealed"],
    ],
  },
  {
    match: /epic|fantasy|myth|legend|kingdom|dragon/i,
    beats: [
      ["crane_reveal", 6, "grand sweeping scale, golden hour"],
      ["slow_push_in", 5, "the hero stands resolute, banners in wind"],
      ["fpv_dive", 4, "swooping over the realm"],
      ["bullet_orbit", 4, "legendary moment, embers in the air"],
    ],
  },
];

const FALLBACK: Beat[] = [
  ["slow_push_in", 5, "opening mood"],
  ["bullet_orbit", 4, "the subject from all sides"],
  ["crash_zoom", 3, "the key detail"],
  ["crane_reveal", 5, "closing reveal"],
];

/** Plan a shot list for a vibe. Returns only move, duration and shot_note. */
export function planVibe(vibe: string): PlannedShot[] {
  const text = vibe.trim();
  const genre = GENRES.find((g) => g.match.test(text));
  const beats = genre?.beats ?? FALLBACK;
  const flavor = genre ? "" : text ? `${text}, ` : "";
  return beats.map(([move, duration, note]) => ({
    move,
    duration,
    shot_note: `${flavor}${note}, ${cam(move)}, cinematic lighting.`,
  }));
}
