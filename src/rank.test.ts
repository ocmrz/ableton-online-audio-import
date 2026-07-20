import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectInput } from "./detect.js";
import { rankCandidates, scoreCandidate } from "./rank.js";
import type { Candidate } from "./types.js";

function make(partial: Partial<Candidate> & Pick<Candidate, "id" | "title">): Candidate {
  return {
    url: `https://www.youtube.com/watch?v=${partial.id}`,
    artists: partial.artists ?? ["Oasis"],
    album: partial.album ?? "Morning Glory",
    durationS: partial.durationS ?? 259,
    source: partial.source ?? "youtube",
    channel: partial.channel ?? null,
    searchRank: partial.searchRank ?? 0,
    ...partial,
  };
}

describe("detectInput", () => {
  it("detects YouTube URLs", () => {
    const d = detectInput("https://www.youtube.com/watch?v=abc123");
    assert.equal(d.kind, "url");
    if (d.kind === "url") assert.equal(d.source, "youtube");
  });

  it("detects SoundCloud URLs", () => {
    const d = detectInput("https://soundcloud.com/artist/track");
    assert.equal(d.kind, "url");
    if (d.kind === "url") assert.equal(d.source, "soundcloud");
  });

  it("treats plain text as query", () => {
    const d = detectInput("wonderwall oasis");
    assert.equal(d.kind, "query");
  });
});

describe("youtubeVideoIdFromUrl", async () => {
  const { youtubeVideoIdFromUrl, isYoutubePlaylistUrl } = await import(
    "./search.js"
  );

  it("parses watch and youtu.be URLs", () => {
    assert.equal(
      youtubeVideoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      "dQw4w9WgXcQ",
    );
    assert.equal(
      youtubeVideoIdFromUrl("https://youtu.be/dQw4w9WgXcQ"),
      "dQw4w9WgXcQ",
    );
  });

  it("returns null for playlist-only URLs", () => {
    assert.equal(
      youtubeVideoIdFromUrl(
        "https://www.youtube.com/playlist?list=PLJCcZPWiV8xx",
      ),
      null,
    );
    assert.equal(
      isYoutubePlaylistUrl(
        "https://www.youtube.com/playlist?list=PLJCcZPWiV8xx",
      ),
      true,
    );
  });

  it("accepts 11-char video ids even if they start with PL", () => {
    assert.equal(
      youtubeVideoIdFromUrl("https://www.youtube.com/watch?v=PLJCcZPWiV8"),
      "PLJCcZPWiV8",
    );
    assert.equal(
      isYoutubePlaylistUrl("https://www.youtube.com/watch?v=PLJCcZPWiV8"),
      false,
    );
  });
});

describe("rankCandidates", () => {
  it("prefers studio over live by default", () => {
    const live = make({
      id: "a",
      title: "Wonderwall (Live at Knebworth)",
      searchRank: 0,
    });
    const studio = make({ id: "b", title: "Wonderwall", searchRank: 1 });
    const ranked = rankCandidates([live, studio], "wonderwall oasis");
    assert.equal(ranked[0]?.candidate.id, "b");
  });

  it("does not false-match Alive as live", () => {
    const scored = scoreCandidate(
      make({
        id: "x",
        title: "Staying Alive",
        artists: ["Bee Gees"],
        album: "Saturday Night Fever",
      }),
      "staying alive bee gees",
    );
    assert.equal(scored.notes.length, 0);
  });

  it("can rank a SoundCloud hit above a weak YouTube hit", () => {
    const yt = make({
      id: "yt",
      title: "Random Mix Hour",
      artists: [],
      album: null,
      durationS: 3600,
      source: "youtube",
      channel: "Someone",
      searchRank: 0,
    });
    const sc = make({
      id: "sc",
      title: "Wonderwall",
      artists: ["Oasis"],
      album: null,
      durationS: 259,
      source: "soundcloud",
      channel: "oasis",
      searchRank: 0,
      url: "https://soundcloud.com/oasis/wonderwall",
    });
    const ranked = rankCandidates([yt, sc], "wonderwall oasis");
    assert.equal(ranked[0]?.candidate.id, "sc");
  });

  it("does not apply song-specific penalties to BBC sound effects", () => {
    const scored = scoreCandidate(
      make({
        id: "bbc",
        title: "Door loop",
        artists: [],
        album: "Daily Life",
        durationS: 10,
        source: "bbc",
      }),
      "door",
    );
    assert.deepEqual(scored.notes, []);
  });
});
