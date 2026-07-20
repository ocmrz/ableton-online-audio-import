import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MediaResolver,
  YOUTUBE_AGE_RESTRICTED_MESSAGE,
  isYoutubeAgeRestriction,
  parseResolvedMediaOutput,
} from "./media.js";
import type { Candidate } from "./types.js";

test("parseResolvedMediaOutput reads tagged yt-dlp output", () => {
  const media = parseResolvedMediaOutput(
    [
      "preview:url=https://media.example/audio.m4a?token=test",
      "preview:ext=m4a",
      "preview:duration=123.45",
      'preview:headers={"User-Agent":"Preview Test","X-Test":"one\\r\\ntwo"}',
    ].join("\n"),
  );

  assert.equal(media.url, "https://media.example/audio.m4a?token=test");
  assert.equal(media.ext, "m4a");
  assert.equal(media.durationS, 123.45);
  assert.deepEqual(media.httpHeaders, {
    "User-Agent": "Preview Test",
    "X-Test": "one two",
  });
});

test("isYoutubeAgeRestriction recognizes YouTube age gates", () => {
  assert.equal(
    isYoutubeAgeRestriction("LOGIN_REQUIRED", "Sign in to confirm your age"),
    true,
  );
  assert.equal(
    isYoutubeAgeRestriction("AGE_VERIFICATION_REQUIRED", undefined),
    true,
  );
  assert.equal(
    isYoutubeAgeRestriction("LOGIN_REQUIRED", "Sign in to confirm you’re not a bot"),
    false,
  );
  assert.equal(
    YOUTUBE_AGE_RESTRICTED_MESSAGE,
    "This audio is age-restricted. Please choose another result.",
  );
});

test("BBC media uses MP3 for preview and WAV for import", async () => {
  const candidate: Candidate = {
    id: "07005210",
    url: "https://sound-effects.bbcrewind.co.uk/search?q=07005210",
    title: "Heavy rain, on turf and trees.",
    artists: [],
    album: "Nature",
    durationS: 367.922744,
    source: "bbc",
    channel: "BBC Sound Effects",
    searchRank: 0,
  };
  const resolver = new MediaResolver("/managed/yt-dlp");
  try {
    const preview = await resolver.resolve(candidate, undefined, "preview");
    const download = await resolver.resolve(candidate, undefined, "download");
    assert.equal(
      preview.url,
      "https://sound-effects-media.bbcrewind.co.uk/mp3/07005210.mp3",
    );
    assert.equal(preview.ext, "mp3");
    assert.equal(
      download.url,
      "https://sound-effects-media.bbcrewind.co.uk/wav/07005210.wav",
    );
    assert.equal(download.ext, "wav");
  } finally {
    resolver.close();
  }
});

test("Internet Archive media picks MP3 for preview and WAV for import", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        files: [
          {
            name: "thunder.mp3",
            format: "VBR MP3",
            length: "12.5",
            size: "200000",
            source: "original",
          },
          {
            name: "thunder.wav",
            format: "WAVE",
            length: "12.5",
            size: "2000000",
            source: "original",
          },
          {
            name: "long-bed.mp3",
            format: "VBR MP3",
            length: "600",
            size: "9000000",
            source: "original",
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

  const candidate: Candidate = {
    id: "thunder-pack",
    url: "https://archive.org/details/thunder-pack",
    title: "Thunder Pack",
    artists: [],
    album: "opensource_audio",
    durationS: null,
    source: "archive",
    channel: "Internet Archive",
    searchRank: 0,
  };
  const resolver = new MediaResolver("/managed/yt-dlp");
  try {
    const preview = await resolver.resolve(candidate, undefined, "preview");
    const download = await resolver.resolve(candidate, undefined, "download");
    assert.equal(
      preview.url,
      "https://archive.org/download/thunder-pack/thunder.mp3",
    );
    assert.equal(preview.ext, "mp3");
    assert.equal(preview.durationS, 12.5);
    assert.equal(
      download.url,
      "https://archive.org/download/thunder-pack/thunder.wav",
    );
    assert.equal(download.ext, "wav");
  } finally {
    resolver.close();
    globalThis.fetch = originalFetch;
  }
});
