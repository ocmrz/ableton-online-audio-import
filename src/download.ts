import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { MediaResolver, type ResolvedMedia } from "./media.js";
import type { Candidate, TimeRange } from "./types.js";
import { runProcess } from "./process.js";

const MAX_DOWNLOAD_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2_000;
const FORCE_DOWNLOAD_FAILURE_FOR_TESTING = false;
const MAX_AUDIO_BASE_NAME_LENGTH = 160;

export interface DownloadProgress {
  pct: number;
  speed: string;
}

export interface DownloadRetry {
  attempt: number;
  maxAttempts: number;
}

export interface DownloadAudioOptions {
  range?: TimeRange;
  ffmpegPath?: string;
  mediaResolver?: Pick<MediaResolver, "resolve" | "invalidate" | "close">;
  onRetry?: (retry: DownloadRetry) => void;
  forceFailureForTesting?: boolean;
  processRunner?: typeof runProcess;
}

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

export function formatFileTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}h${String(minutes).padStart(2, "0")}m${String(remainder).padStart(2, "0")}s`;
  }
  return `${String(minutes).padStart(2, "0")}m${String(remainder).padStart(2, "0")}s`;
}

function sanitizeFileName(value: string): string {
  let safe = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)) {
    safe = `_${safe}`;
  }
  return safe;
}

export function audioBaseName(
  candidate: Candidate,
  range?: TimeRange,
): string {
  const title = candidate.title.trim() || candidate.id;
  const channel = candidate.channel?.replace(/\s+-\s+Topic$/i, "").trim();
  const artist = candidate.artists.map((value) => value.trim()).filter(Boolean).join(", ");
  const label = artist || channel;
  let core = sanitizeFileName(label ? `${label} - ${title}` : title);
  if (!core) core = sanitizeFileName(candidate.id) || "Online Audio";

  const suffix = range
    ? ` [${formatFileTime(range.startS)}-${formatFileTime(range.endS)}]`
    : "";
  const maxCoreLength = Math.max(1, MAX_AUDIO_BASE_NAME_LENGTH - suffix.length);
  core = core.slice(0, maxCoreLength).replace(/[. ]+$/g, "");
  return `${core}${suffix}`;
}

async function uniqueBaseName(
  tempDir: string,
  desired: string,
): Promise<string> {
  const files = await fsp.readdir(tempDir).catch(() => [] as string[]);
  const lowerFiles = files.map((file) => file.toLowerCase());
  const isUsed = (base: string) => {
    const lower = base.toLowerCase();
    return lowerFiles.some(
      (file) => file === lower || file.startsWith(`${lower}.`),
    );
  };
  if (!isUsed(desired)) return desired;
  for (let copy = 2; ; copy += 1) {
    const candidate = `${desired} (${copy})`;
    if (!isUsed(candidate)) return candidate;
  }
}

export function normalizeTimeRange(
  range: TimeRange | undefined,
  durationS: number | null,
): TimeRange | null {
  if (!range) return null;
  const startS = Math.max(0, range.startS);
  const endS =
    durationS == null ? range.endS : Math.min(range.endS, durationS);
  if (!Number.isFinite(startS) || !Number.isFinite(endS) || endS <= startS) {
    throw new Error("The selected audio range is invalid.");
  }
  if (startS <= 0.05 && durationS != null && endS >= durationS - 0.25) {
    return null;
  }
  if (endS - startS < 0.25) {
    throw new Error("Select at least 0.25 seconds of audio.");
  }
  return { startS, endS };
}

function ffmpegHttpArgs(headers: Record<string, string>): string[] {
  const args: string[] = [];
  const extra: string[] = [];
  const blocked = new Set([
    "accept-encoding",
    "connection",
    "content-length",
    "host",
    "range",
  ]);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (blocked.has(lower)) continue;
    if (lower === "user-agent") {
      args.push("-user_agent", value);
    } else if (lower === "referer") {
      args.push("-referer", value);
    } else {
      extra.push(`${name}: ${value}\r\n`);
    }
  }
  if (extra.length > 0) args.push("-headers", extra.join(""));
  return args;
}

export function ffmpegWavArgs(
  media: ResolvedMedia,
  outputPath: string,
  range: TimeRange | null = null,
): string[] {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    ...ffmpegHttpArgs(media.httpHeaders),
  ];
  if (range) args.push("-ss", range.startS.toFixed(3));
  args.push("-i", media.url);
  if (range) args.push("-t", (range.endS - range.startS).toFixed(3));
  args.push(
    "-map",
    "0:a:0",
    "-vn",
    "-c:a",
    "pcm_s16le",
    "-progress",
    "pipe:1",
    "-nostats",
    outputPath,
  );
  return args;
}

function isTransientDownloadFailure(stderr: string): boolean {
  return /(?:HTTP (?:Error|error)|Server returned)\s*403|403\s+Forbidden/i.test(
    stderr,
  );
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function removeAttemptFiles(tempDir: string, base: string): Promise<void> {
  try {
    const files = await fsp.readdir(tempDir);
    await Promise.all(
      files
        .filter((file) => file.startsWith(base + "."))
        .map((file) => fsp.unlink(path.join(tempDir, file)).catch(() => {})),
    );
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Resolve the source stream and let FFmpeg download it directly into a
 * Live-compatible PCM WAV. No compressed intermediate file is written.
 */
export async function downloadAudio(
  ytDlpPath: string,
  candidate: Candidate,
  tempDir: string,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
  options: DownloadAudioOptions = {},
): Promise<string> {
  const forceFailureForTesting =
    options.forceFailureForTesting ?? FORCE_DOWNLOAD_FAILURE_FOR_TESTING;
  const range = normalizeTimeRange(options.range, candidate.durationS);
  const ffmpegPath = options.ffmpegPath;
  if (!ffmpegPath) {
    throw new Error("The managed audio converter is not ready.");
  }

  const base = await uniqueBaseName(
    tempDir,
    audioBaseName(candidate, range ?? undefined),
  );
  const outputPath = path.join(tempDir, `${base}.wav`);
  const resolver = options.mediaResolver ?? new MediaResolver(ytDlpPath);
  const ownsResolver = !options.mediaResolver;
  const processRunner = options.processRunner ?? runProcess;

  const prepareRetry = async (
    detail: string,
    attempt: number,
  ): Promise<boolean> => {
    if (
      attempt >= MAX_DOWNLOAD_ATTEMPTS ||
      !isTransientDownloadFailure(detail)
    ) {
      return false;
    }
    resolver.invalidate(candidate, "download");
    options.onRetry?.({
      attempt: attempt + 1,
      maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
    });
    if (!forceFailureForTesting) {
      await waitForRetry(RETRY_DELAY_MS, signal);
    }
    return true;
  };

  try {
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
      let media: ResolvedMedia;
      try {
        media = await resolver.resolve(candidate, signal, "download");
      } catch (error) {
        if (signal.aborted) throw new Error("aborted");
        const detail = error instanceof Error ? error.message : String(error);
        if (await prepareRetry(detail, attempt)) continue;
        throw error;
      }

      if (signal.aborted) throw new Error("aborted");
      const durationS = range
        ? range.endS - range.startS
        : (media.durationS ?? candidate.durationS);
      const args = ffmpegWavArgs(media, outputPath, range);
      let result;
      try {
        result = forceFailureForTesting
          ? {
              stdout: "",
              stderr:
                "HTTP error 403 Forbidden (forced for retry-dialog testing)",
              code: 1,
            }
          : await processRunner(
              ffmpegPath,
              args,
              signal,
              (raw) => {
                if (durationS == null || durationS <= 0) return;
                const outTime = /^out_time_us=(\d+)$/.exec(raw.trim());
                if (!outTime?.[1]) return;
                const elapsedS = Number(outTime[1]) / 1_000_000;
                const pct = Math.min(
                  99,
                  Math.max(0, Math.round((elapsedS / durationS) * 100)),
                );
                onProgress({ pct, speed: "" });
              },
            );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(
            "The managed audio converter could not be started. Try importing again.",
          );
        }
        throw error;
      }

      if (signal.aborted) throw new Error("aborted");
      if (result.code === 0) {
        await fsp.access(outputPath);
        onProgress({ pct: 100, speed: "" });
        return outputPath;
      }

      await removeAttemptFiles(tempDir, base);
      if (await prepareRetry(result.stderr, attempt)) continue;
      throw new DownloadError(
        `Audio download and conversion failed (FFmpeg exit ${result.code}).\n${result.stderr.slice(-800)}`,
      );
    }

    throw new DownloadError("Audio download and conversion failed after retrying.");
  } finally {
    if (ownsResolver) resolver.close();
  }
}
