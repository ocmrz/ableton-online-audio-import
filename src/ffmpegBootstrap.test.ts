import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import {
  ffmpegAssetForPlatform,
  ffmpegPaths,
} from "./ffmpegBootstrap.js";

test("ffmpegAssetForPlatform selects verified release assets", () => {
  assert.equal(
    ffmpegAssetForPlatform("darwin", "arm64").asset,
    "ffmpeg-osx-arm64",
  );
  assert.equal(
    ffmpegAssetForPlatform("darwin", "x64").asset,
    "ffmpeg-osx-x64",
  );
  assert.equal(
    ffmpegAssetForPlatform("win32", "x64").asset,
    "ffmpeg-win-x64.exe",
  );
  assert.match(
    ffmpegAssetForPlatform("linux", "x64").sha256,
    /^[a-f0-9]{64}$/,
  );
  assert.throws(
    () => ffmpegAssetForPlatform("win32", "arm64"),
    /not available for win32\/arm64/,
  );
});

test("ffmpegPaths keeps the managed binary in extension storage", () => {
  const mac = ffmpegPaths("/extension-storage", "darwin");
  assert.equal(mac.binPath, path.join("/extension-storage", "bin", "ffmpeg"));
  assert.equal(
    mac.versionPath,
    path.join("/extension-storage", "bin", "ffmpeg-version.txt"),
  );

  const windows = ffmpegPaths("C:\\storage", "win32");
  assert.equal(path.basename(windows.binPath), "ffmpeg.exe");
});
