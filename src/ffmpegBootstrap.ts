import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const FFMPEG_RELEASE = "n8.0.1-1";
const RELEASE_BASE =
  `https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/${FFMPEG_RELEASE}`;

export interface FfmpegAsset {
  asset: string;
  sha256: string;
}

const ASSETS: Record<string, FfmpegAsset> = {
  "darwin-arm64": {
    asset: "ffmpeg-osx-arm64",
    sha256: "c334b7f418e10201dc6c8e42407f5198c3270524cc77d40606e746be3c49159a",
  },
  "darwin-x64": {
    asset: "ffmpeg-osx-x64",
    sha256: "5b12ece6e1cdecff3a2af544dc85f6c91c0085b1098adc34fd3f09560b7b3c62",
  },
  "linux-arm64": {
    asset: "ffmpeg-linux-arm64",
    sha256: "ff183f17f37a6a704ec0a4f5dbdc42519a1564366470ddd7e4d0474d07c8a3c8",
  },
  "linux-x64": {
    asset: "ffmpeg-linux-x64",
    sha256: "b66cc32cd45584ff5f65b8957be4fa93b43d002c502808248f6de3fc5cbc1c31",
  },
  "win32-x64": {
    asset: "ffmpeg-win-x64.exe",
    sha256: "73d555001653d97d3bb328e68e3eb36cf0dca395babd3714d4e51c42da9b16ba",
  },
};

export function ffmpegAssetForPlatform(
  platform: NodeJS.Platform = os.platform(),
  arch: string = os.arch(),
): FfmpegAsset {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset) {
    throw new Error(
      `Automatic audio-converter setup is not available for ${platform}/${arch}.`,
    );
  }
  return asset;
}

export interface FfmpegPaths {
  binDir: string;
  binPath: string;
  versionPath: string;
  noticePath: string;
}

export function ffmpegPaths(
  storageDir: string,
  platform: NodeJS.Platform = os.platform(),
): FfmpegPaths {
  const binDir = path.join(storageDir, "bin");
  return {
    binDir,
    binPath: path.join(binDir, platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    versionPath: path.join(binDir, "ffmpeg-version.txt"),
    noticePath: path.join(binDir, "FFmpeg-NOTICE.txt"),
  };
}

async function readText(file: string): Promise<string | null> {
  try {
    return (await fsp.readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

async function downloadVerifiedFile(
  url: string,
  destination: string,
  expectedSha256: string,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    ...(signal ? { signal } : {}),
    headers: { "User-Agent": "online-audio-import" },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`FFmpeg download failed (HTTP ${response.status}).`);
  }

  const total = Number(response.headers.get("content-length") || 0);
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  const file = await fsp.open(destination, "w");
  let received = 0;
  let lastReported = -1;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) throw new Error("aborted");
      await file.write(value);
      hash.update(value);
      received += value.byteLength;
      if (total > 0 && onProgress) {
        const pct = Math.min(99, Math.round((received / total) * 100));
        if (pct >= lastReported + 5) {
          lastReported = pct;
          onProgress(pct);
        }
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    await file.close();
  }

  const actualSha256 = hash.digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("The downloaded FFmpeg file failed its security check.");
  }
}

async function clearMacOSQuarantine(binPath: string): Promise<void> {
  if (os.platform() !== "darwin") return;
  try {
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve) => {
      const child = spawn("xattr", ["-d", "com.apple.quarantine", binPath]);
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
  } catch {
    /* The downloaded file normally has no quarantine attribute. */
  }
}

function ffmpegNotice(asset: FfmpegAsset): string {
  return [
    "FFmpeg",
    "",
    `Binary release: ${FFMPEG_RELEASE}`,
    `Binary asset: ${asset.asset}`,
    `SHA-256: ${asset.sha256}`,
    `Binary source: https://github.com/shaka-project/static-ffmpeg-binaries/releases/tag/${FFMPEG_RELEASE}`,
    "Build scripts: https://github.com/shaka-project/static-ffmpeg-binaries",
    "FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/n8.0.1",
    "License: GNU General Public License version 3 or later",
    "License text: https://github.com/FFmpeg/FFmpeg/blob/n8.0.1/COPYING.GPLv3",
    "",
    "FFmpeg is a separate program and is not covered by Online Audio's MIT license.",
    "",
  ].join("\n");
}

const activeInstalls = new Map<string, Promise<string>>();

/**
 * Ensure a verified FFmpeg binary exists under storageDir.
 * The pinned binary is downloaded on the first import and reused afterward.
 */
export function ensureFfmpeg(
  storageDir: string,
  opts?: {
    onStatus?: (message: string, pct?: number) => void;
    signal?: AbortSignal;
  },
): Promise<string> {
  const paths = ffmpegPaths(storageDir);
  const active = activeInstalls.get(paths.binPath);
  if (active) return active;

  const installation = (async () => {
    await fsp.mkdir(paths.binDir, { recursive: true });
    const installed =
      fs.existsSync(paths.binPath) &&
      (await readText(paths.versionPath)) === FFMPEG_RELEASE;
    if (installed) return paths.binPath;

    const asset = ffmpegAssetForPlatform();
    const partialPath = `${paths.binPath}.partial`;
    await fsp.rm(partialPath, { force: true });
    opts?.onStatus?.("Downloading audio converter…", 0);

    try {
      await downloadVerifiedFile(
        `${RELEASE_BASE}/${asset.asset}`,
        partialPath,
        asset.sha256,
        (pct) => opts?.onStatus?.("Downloading audio converter…", pct),
        opts?.signal,
      );
      if (opts?.signal?.aborted) throw new Error("aborted");
      if (os.platform() !== "win32") await fsp.chmod(partialPath, 0o755);
      await clearMacOSQuarantine(partialPath);
      await fsp.rm(paths.binPath, { force: true });
      await fsp.rename(partialPath, paths.binPath);
      await fsp.writeFile(paths.versionPath, FFMPEG_RELEASE, "utf8");
      await fsp.writeFile(paths.noticePath, ffmpegNotice(asset), "utf8");
      opts?.onStatus?.("Audio converter ready", 100);
      return paths.binPath;
    } finally {
      await fsp.rm(partialPath, { force: true }).catch(() => {});
    }
  })().finally(() => {
    activeInstalls.delete(paths.binPath);
  });

  activeInstalls.set(paths.binPath, installation);
  return installation;
}
