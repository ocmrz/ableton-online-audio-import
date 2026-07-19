import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  audioBaseName,
  downloadAudio,
  ffmpegWavArgs,
  formatFileTime,
  normalizeTimeRange,
} from "./download.js";
import type { ResolvedMedia } from "./media.js";
import type { Candidate } from "./types.js";

test("audioBaseName creates portable human-readable names", () => {
  const candidate: Candidate = {
    id: "xtRVa4kOBt4",
    url: "https://www.youtube.com/watch?v=xtRVa4kOBt4",
    title: "Get: Lucky / Remix?",
    artists: ["Daft Punk"],
    album: null,
    durationS: 240,
    source: "youtube",
    channel: "Daft Punk - Topic",
    searchRank: 0,
  };

  assert.equal(formatFileTime(70.2), "01m10s");
  assert.equal(formatFileTime(3723), "01h02m03s");
  assert.equal(audioBaseName(candidate), "Daft Punk - Get Lucky Remix");
  assert.equal(
    audioBaseName(candidate, { startS: 70.2, endS: 102.4 }),
    "Daft Punk - Get Lucky Remix [01m10s-01m42s]",
  );
});

test("normalizeTimeRange skips a full-track selection", () => {
  assert.equal(
    normalizeTimeRange({ startS: 0, endS: 240 }, 240),
    null,
  );
  assert.deepEqual(
    normalizeTimeRange({ startS: 12.5, endS: 48.25 }, 240),
    { startS: 12.5, endS: 48.25 },
  );
});

test("ffmpegWavArgs converts the direct stream to PCM WAV", () => {
  const media: ResolvedMedia = {
    url: "https://media.example/audio.m4a?token=test",
    ext: "m4a",
    durationS: 240,
    httpHeaders: { "User-Agent": "Online Audio Test" },
  };
  const args = ffmpegWavArgs(media, "/tmp/output.wav", {
    startS: 12.5,
    endS: 48.25,
  });

  assert.equal(args[args.indexOf("-i") + 1], media.url);
  assert.equal(args[args.indexOf("-ss") + 1], "12.500");
  assert.equal(args[args.indexOf("-t") + 1], "35.750");
  assert.equal(args[args.indexOf("-c:a") + 1], "pcm_s16le");
  assert.equal(args.at(-1), "/tmp/output.wav");
  assert.ok(!args.includes("copy"));
});

test("downloadAudio retries a transient FFmpeg 403 with a fresh stream", async () => {
  const tempDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "online-audio-download-"),
  );
  const candidate: Candidate = {
    id: "test-video",
    url: "https://www.youtube.com/watch?v=test-video",
    title: "Test video",
    artists: [],
    album: null,
    durationS: 120,
    source: "youtube",
    channel: null,
    searchRank: 0,
  };
  const media: ResolvedMedia = {
    url: "https://media.example/audio.m4a?token=test",
    ext: "m4a",
    durationS: 120,
    httpHeaders: {},
  };

  try {
    const retries: number[] = [];
    let resolveCount = 0;
    let invalidations = 0;
    let conversionAttempts = 0;
    const output = await downloadAudio(
      "/managed/yt-dlp",
      candidate,
      tempDir,
      () => {},
      new AbortController().signal,
      {
        ffmpegPath: "/managed/ffmpeg",
        mediaResolver: {
          resolve: async () => {
            resolveCount += 1;
            return media;
          },
          invalidate: () => {
            invalidations += 1;
          },
          close: () => {},
        },
        onRetry: ({ attempt }) => retries.push(attempt),
        forceFailureForTesting: false,
        processRunner: async (_bin, args, _signal, onStdoutLine) => {
          conversionAttempts += 1;
          if (conversionAttempts === 1) {
            return {
              stdout: "",
              stderr: "HTTP error 403 Forbidden",
              code: 1,
            };
          }
          const outputPath = args.at(-1);
          assert.ok(outputPath);
          await fsp.writeFile(outputPath, "RIFF audio", "utf8");
          onStdoutLine?.("out_time_us=120000000");
          return { stdout: "", stderr: "", code: 0 };
        },
      },
    );

    assert.deepEqual(retries, [2]);
    assert.equal(resolveCount, 2);
    assert.equal(invalidations, 1);
    assert.equal(await fsp.readFile(output, "utf8"), "RIFF audio");
    assert.equal(path.basename(output), "Test video.wav");
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});
