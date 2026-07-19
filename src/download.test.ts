import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  audioBaseName,
  downloadAudio,
  formatFileTime,
  normalizeTimeRange,
} from "./download.js";
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

test("downloadAudio retries a transient 403 with a fresh download", async () => {
  const tempDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "online-audio-download-"),
  );
  const stateFile = path.join(tempDir, "attempted");
  const mockDownloader = path.join(tempDir, "mock-downloader.mjs");
  const candidate: Candidate = {
    id: "test-video",
    url: mockDownloader,
    title: "Test video",
    artists: [],
    album: null,
    durationS: null,
    source: "youtube",
    channel: null,
    searchRank: 0,
  };

  await fsp.writeFile(
    mockDownloader,
    `import * as fs from "node:fs";
const stateFile = ${JSON.stringify(stateFile)};
if (!fs.existsSync(stateFile)) {
  fs.writeFileSync(stateFile, "failed once");
  console.error("ERROR: unable to download video data: HTTP Error 403: Forbidden");
  process.exit(1);
}
const outputIndex = process.argv.indexOf("-o") + 1;
const output = process.argv[outputIndex].replace("%(ext)s", "m4a");
fs.writeFileSync(output, "audio");
console.log(output);
`,
    "utf8",
  );

  try {
    const retries: number[] = [];
    const output = await downloadAudio(
      process.execPath,
      candidate,
      tempDir,
      () => {},
      new AbortController().signal,
      {
        onRetry: ({ attempt }) => retries.push(attempt),
        forceFailureForTesting: false,
      },
    );

    assert.deepEqual(retries, [2]);
    assert.equal(await fsp.readFile(output, "utf8"), "audio");
    assert.equal(path.basename(output), "Test video.m4a");
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});
