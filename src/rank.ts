import type { Candidate, ScoredCandidate } from "./types.js";
import { artistStr } from "./types.js";

const VARIANT_KEYWORDS = [
  "live",
  "cover",
  "remix",
  "sped up",
  "slowed",
  "nightcore",
  "8d",
  "reverb",
  "instrumental",
  "karaoke",
  "acoustic",
  "demo",
  "extended",
  "mashup",
  "medley",
  "loop",
] as const;

const MIN_DURATION_S = 60;
const MAX_DURATION_S = 600;

const W_VARIANT = -4.0;
const W_DURATION = -3.0;
const W_MATCH = 5.0;
const W_SEARCH_RANK = 1.0;
const W_TOPIC = 2.0;
const W_YTM = 4.0;
const W_AUDIO_HINT = 1.0;

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hasWord(text: string, phrase: string): boolean {
  return ` ${norm(text)} `.includes(` ${norm(phrase)} `);
}

export function scoreCandidate(c: Candidate, query: string): ScoredCandidate {
  const notes: string[] = [];
  let score = 0;

  const isSoundEffect = c.source === "bbc" || c.kind === "sound-effect";
  if (!isSoundEffect) {
    const variantText = `${c.title} ${c.album ?? ""}`;
    for (const keyword of VARIANT_KEYWORDS) {
      if (hasWord(variantText, keyword) && !hasWord(query, keyword)) {
        score += W_VARIANT;
        notes.push(`variant "${keyword}"`);
      }
    }

    if (
      c.durationS !== null &&
      !(MIN_DURATION_S <= c.durationS && c.durationS <= MAX_DURATION_S)
    ) {
      score += W_DURATION;
      notes.push(`odd duration (${c.durationS}s)`);
    }
  }

  const queryWords = new Set(norm(query).split(/\s+/).filter(Boolean));
  const targetWords = new Set(
    norm(`${artistStr(c)} ${c.title} ${c.album ?? ""}`).split(/\s+/).filter(Boolean),
  );
  if (queryWords.size > 0) {
    let overlap = 0;
    for (const w of queryWords) if (targetWords.has(w)) overlap += 1;
    score += W_MATCH * (overlap / queryWords.size);
  }

  score += W_SEARCH_RANK / (1 + c.searchRank);

  if (c.source === "youtube") {
    if (c.url.includes("music.youtube.com")) {
      score += W_YTM;
      notes.push("youtube music");
    } else if (c.channel?.endsWith(" - Topic")) {
      score += W_TOPIC;
      notes.push("topic channel");
    }
    if (hasWord(c.title, "audio")) {
      score += W_AUDIO_HINT;
      notes.push("audio-titled");
    }
  }

  return { candidate: c, score, notes };
}

export function rankCandidates(
  candidates: Candidate[],
  query: string,
): ScoredCandidate[] {
  const scored = candidates.map((c) => scoreCandidate(c, query));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.candidate.searchRank - b.candidate.searchRank;
  });
  return scored;
}
