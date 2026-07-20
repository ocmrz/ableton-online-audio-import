import type { Candidate } from "./types.js";
import { runProcess } from "./process.js";

const DIRECT_AUDIO_FORMAT = [
  "bestaudio[ext=m4a][protocol=https]",
  "bestaudio[ext=mp3][protocol=https]",
  "bestaudio[protocol=https]",
  "bestaudio[ext=m4a][protocol=http]",
  "bestaudio[ext=mp3][protocol=http]",
  "bestaudio[protocol=http]",
  "best[protocol=https]",
  "best[protocol=http]",
].join("/");

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 8;
const BBC_MEDIA_BASE_URL = "https://sound-effects-media.bbcrewind.co.uk";
const ARCHIVE_METADATA_URL = "https://archive.org/metadata";
const ARCHIVE_DOWNLOAD_BASE_URL = "https://archive.org/download";
const ARCHIVE_AUDIO_EXT = /^(mp3|ogg|flac|wav|m4a|aif|aiff)$/i;
const ARCHIVE_USER_AGENT =
  "Online-Audio/0.3 (Ableton Live extension; +https://github.com/)";
const YOUTUBE_PLAYER_URL =
  "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const IOS_USER_AGENT =
  "com.google.ios.youtube/21.02.3 " +
  "(iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)";
const ANDROID_VR_USER_AGENT =
  "com.google.android.apps.youtube.vr.oculus/1.65.10 " +
  "(Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip";
export const YOUTUBE_AGE_RESTRICTED_MESSAGE =
  "This audio is age-restricted. Please choose another result.";

export type MediaProfile = "preview" | "download";

export interface ResolvedMedia {
  url: string;
  ext: string;
  durationS: number | null;
  httpHeaders: Record<string, string>;
}

interface CacheEntry {
  createdAt: number;
  controller: AbortController;
  promise: Promise<ResolvedMedia>;
}

interface YoutubeAudioFormat {
  itag?: number;
  url?: string;
  mimeType?: string;
  bitrate?: number;
  approxDurationMs?: string;
}

interface YoutubePlayerResponse {
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
  videoDetails?: {
    lengthSeconds?: string;
  };
  streamingData?: {
    adaptiveFormats?: YoutubeAudioFormat[];
  };
}

interface YoutubeClient {
  userAgent: string;
  context: Record<string, unknown>;
}

class YoutubeAgeRestrictionError extends Error {
  constructor() {
    super(YOUTUBE_AGE_RESTRICTED_MESSAGE);
    this.name = "YoutubeAgeRestrictionError";
  }
}

const YOUTUBE_CLIENTS: YoutubeClient[] = [
  {
    userAgent: IOS_USER_AGENT,
    context: {
      clientName: "IOS",
      clientVersion: "21.02.3",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
    },
  },
  {
    userAgent: ANDROID_VR_USER_AGENT,
    context: {
      clientName: "ANDROID_VR",
      clientVersion: "1.65.10",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      androidSdkVersion: 32,
      osName: "Android",
      osVersion: "12L",
    },
  },
];

export function isYoutubeAgeRestriction(
  status: string | undefined,
  reason: string | undefined,
): boolean {
  if (
    status === "AGE_CHECK_REQUIRED" ||
    status === "AGE_VERIFICATION_REQUIRED" ||
    status === "CONTENT_CHECK_REQUIRED"
  ) {
    return true;
  }
  return /(?:\bage[- ]?restrict(?:ed|ion)?\b|\b(?:confirm|verify) (?:your )?age\b|\bmay be inappropriate for some users\b)/i.test(
    reason || "",
  );
}

function cacheKey(candidate: Candidate, profile: MediaProfile): string {
  return `${profile}:${candidate.source}:${candidate.id}:${candidate.url}`;
}

function parseDuration(raw: string | undefined): number | null {
  if (!raw || raw === "NA" || raw === "None") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function resolveBbcDirect(
  candidate: Candidate,
  profile: MediaProfile,
): ResolvedMedia {
  if (!/^[a-zA-Z0-9_-]+$/.test(candidate.id)) {
    throw new Error("Invalid BBC Sound Effects id.");
  }
  const ext = profile === "preview" ? "mp3" : "wav";
  return {
    url: `${BBC_MEDIA_BASE_URL}/${ext}/${candidate.id}.${ext}`,
    ext,
    durationS: candidate.durationS,
    httpHeaders: {},
  };
}

interface ArchiveFile {
  name?: string;
  format?: string;
  length?: string;
  size?: string;
  source?: string;
}

function archiveFileExt(name: string): string {
  const match = /\.([a-zA-Z0-9]{1,8})$/.exec(name);
  return match?.[1]?.toLowerCase() ?? "";
}

function archiveFileStem(name: string): string {
  return name.replace(/\.[^.]+$/, "").toLowerCase();
}

function isArchiveAudioFile(file: ArchiveFile): boolean {
  const name = file.name?.trim() ?? "";
  if (!name || name.includes("/") || name.includes("\\")) return false;
  const ext = archiveFileExt(name);
  if (!ARCHIVE_AUDIO_EXT.test(ext)) return false;
  // Skip obvious non-track side-car names.
  if (/\b(_64kb|spectrogram|sample)\b/i.test(name)) return false;
  return true;
}

function archiveLengthS(file: ArchiveFile): number | null {
  const value = Number(file.length);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function archiveFormatScore(file: ArchiveFile, profile: MediaProfile): number {
  const ext = archiveFileExt(file.name || "");
  const previewRank: Record<string, number> = {
    mp3: 100,
    m4a: 80,
    ogg: 60,
    flac: 40,
    wav: 20,
    aif: 20,
    aiff: 20,
  };
  const downloadRank: Record<string, number> = {
    wav: 100,
    aiff: 95,
    aif: 95,
    flac: 90,
    mp3: 50,
    m4a: 40,
    ogg: 30,
  };
  const rank = (profile === "preview" ? previewRank : downloadRank)[ext] ?? 0;
  const originalBoost = file.source === "original" ? 5 : 0;
  const size = Number(file.size) || 0;
  // Preview: smaller files start faster. Download: prefer larger of same format.
  const sizeTerm = profile === "preview" ? -size : size;
  return rank * 1e12 + originalBoost * 1e11 + sizeTerm;
}

/** Duration of the audio file this extension would preview from an IA item. */
export function durationFromArchiveFiles(files: ArchiveFile[]): number | null {
  const file = pickArchiveAudioFile(files, "preview");
  return file ? archiveLengthS(file) : null;
}

function pickArchiveAudioFile(
  files: ArchiveFile[],
  profile: MediaProfile,
): ArchiveFile | null {
  const audio = files.filter(isArchiveAudioFile);
  if (audio.length === 0) return null;

  const byStem = new Map<string, ArchiveFile[]>();
  for (const file of audio) {
    const stem = archiveFileStem(file.name || "");
    const group = byStem.get(stem);
    if (group) group.push(file);
    else byStem.set(stem, [file]);
  }

  const stems = [...byStem.entries()].sort((a, b) => {
    const lengthA =
      a[1].map(archiveLengthS).find((value) => value != null) ?? null;
    const lengthB =
      b[1].map(archiveLengthS).find((value) => value != null) ?? null;
    // Prefer shorter tracks so multi-file packs surface a usable clip.
    if (lengthA != null && lengthB != null && lengthA !== lengthB) {
      return lengthA - lengthB;
    }
    if (lengthA != null && lengthB == null) return -1;
    if (lengthA == null && lengthB != null) return 1;
    return a[0].localeCompare(b[0]);
  });

  const group = stems[0]?.[1] ?? [];
  group.sort(
    (a, b) => archiveFormatScore(b, profile) - archiveFormatScore(a, profile),
  );
  return group[0] ?? null;
}

async function resolveArchiveDirect(
  candidate: Candidate,
  signal: AbortSignal,
  profile: MediaProfile,
): Promise<ResolvedMedia> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/.test(candidate.id)) {
    throw new Error("Invalid Internet Archive id.");
  }

  const res = await fetch(
    `${ARCHIVE_METADATA_URL}/${encodeURIComponent(candidate.id)}`,
    {
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": ARCHIVE_USER_AGENT,
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Internet Archive metadata HTTP ${res.status}`);
  }
  const data = (await res.json()) as { files?: ArchiveFile[] };
  const file = pickArchiveAudioFile(data.files ?? [], profile);
  if (!file?.name) {
    throw new Error("Internet Archive item has no playable audio file.");
  }

  const ext = archiveFileExt(file.name) || "mp3";
  return {
    url: `${ARCHIVE_DOWNLOAD_BASE_URL}/${encodeURIComponent(candidate.id)}/${encodeURIComponent(file.name)}`,
    ext,
    durationS: archiveLengthS(file) ?? candidate.durationS,
    httpHeaders: {},
  };
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== "string") continue;
      // Never allow an extracted value to inject another HTTP header.
      headers[name] = value.replace(/[\r\n]+/g, " ");
    }
    return headers;
  } catch {
    return {};
  }
}

function youtubeFormatScore(
  format: YoutubeAudioFormat,
  profile: MediaProfile,
): number {
  const mime = format.mimeType || "";
  const containerScore = mime.startsWith("audio/mp4") ? 1_000_000 : 0;
  if (profile === "preview") {
    const lowAacScore = format.itag === 139 ? 100_000 : 0;
    return containerScore + lowAacScore - (format.bitrate || 0);
  }
  const standardAacScore = format.itag === 140 ? 100_000 : 0;
  return containerScore + standardAacScore + (format.bitrate || 0);
}

function youtubeDurationS(
  response: YoutubePlayerResponse,
  format: YoutubeAudioFormat,
): number | null {
  const milliseconds = Number(format.approxDurationMs);
  if (Number.isFinite(milliseconds) && milliseconds > 0) {
    return milliseconds / 1000;
  }
  return parseDuration(response.videoDetails?.lengthSeconds);
}

async function resolveYoutubeWithClient(
  candidate: Candidate,
  signal: AbortSignal,
  profile: MediaProfile,
  client: YoutubeClient,
): Promise<ResolvedMedia> {
  const response = await fetch(YOUTUBE_PLAYER_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": client.userAgent,
    },
    body: JSON.stringify({
      context: {
        client: {
          hl: "en",
          gl: "US",
          ...client.context,
        },
      },
      videoId: candidate.id,
    }),
  });
  if (!response.ok) {
    throw new Error(`YouTube player returned HTTP ${response.status}.`);
  }

  const data = (await response.json()) as YoutubePlayerResponse;
  if (data.playabilityStatus?.status !== "OK") {
    if (
      isYoutubeAgeRestriction(
        data.playabilityStatus?.status,
        data.playabilityStatus?.reason,
      )
    ) {
      throw new YoutubeAgeRestrictionError();
    }
    throw new Error(
      data.playabilityStatus?.reason || "YouTube preview is unavailable.",
    );
  }

  const formats = (data.streamingData?.adaptiveFormats || [])
    .filter(
      (format) =>
        typeof format.url === "string" &&
        format.mimeType?.startsWith("audio/"),
    )
    .sort(
      (a, b) =>
        youtubeFormatScore(b, profile) - youtubeFormatScore(a, profile),
    );
  const format = formats[0];
  if (!format?.url) {
    throw new Error("YouTube did not return a direct audio format.");
  }

  const mediaUrl = new URL(format.url);
  if (
    mediaUrl.protocol !== "https:" ||
    !mediaUrl.hostname.endsWith(".googlevideo.com")
  ) {
    throw new Error("YouTube returned an unexpected media host.");
  }

  // Validate the signed URL before giving it to the browser. Some clients can
  // return formats that require a PO token and fail with HTTP 403.
  const probe = await fetch(mediaUrl, {
    signal,
    headers: {
      "User-Agent": client.userAgent,
      Range: "bytes=0-0",
      "Accept-Encoding": "identity",
    },
  });
  if (probe.status !== 200 && probe.status !== 206) {
    await probe.body?.cancel();
    throw new Error(`YouTube audio returned HTTP ${probe.status}.`);
  }
  await probe.body?.cancel();

  const mime = (format.mimeType || "").split(";", 1)[0];
  return {
    url: format.url,
    ext: mime === "audio/mp4" ? "m4a" : "webm",
    durationS: youtubeDurationS(data, format),
    httpHeaders: { "User-Agent": client.userAgent },
  };
}

async function resolveYoutubeDirect(
  candidate: Candidate,
  signal: AbortSignal,
  profile: MediaProfile,
): Promise<ResolvedMedia> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(candidate.id)) {
    throw new Error("Invalid YouTube video id.");
  }

  let lastError: unknown = new Error("YouTube preview is unavailable.");
  let ageRestrictionError: YoutubeAgeRestrictionError | null = null;
  for (const client of YOUTUBE_CLIENTS) {
    try {
      return await resolveYoutubeWithClient(
        candidate,
        signal,
        profile,
        client,
      );
    } catch (error) {
      if (signal.aborted) throw new Error("aborted");
      if (error instanceof YoutubeAgeRestrictionError) {
        ageRestrictionError = error;
      }
      lastError = error;
    }
  }
  throw ageRestrictionError || lastError;
}

export function parseResolvedMediaOutput(stdout: string): ResolvedMedia {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^preview:(url|ext|duration|headers)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] != null) values.set(match[1], match[2]);
  }

  const url = values.get("url");
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error("The source did not provide a directly playable audio stream.");
  }

  const rawExt = values.get("ext") || "m4a";
  const ext = /^[a-zA-Z0-9]{1,8}$/.test(rawExt) ? rawExt.toLowerCase() : "m4a";
  return {
    url,
    ext,
    durationS: parseDuration(values.get("duration")),
    httpHeaders: parseHeaders(values.get("headers")),
  };
}

function waitForCaller<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Resolves source pages into short-lived, direct audio URLs. Resolution is
 * cached so preview and selected-range import share the same yt-dlp result.
 */
export class MediaResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly ytDlpPath: string) {}

  resolve(
    candidate: Candidate,
    signal?: AbortSignal,
    profile: MediaProfile = "preview",
  ): Promise<ResolvedMedia> {
    const key = cacheKey(candidate, profile);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.createdAt < CACHE_TTL_MS) {
      return waitForCaller(cached.promise, signal);
    }
    if (cached) {
      cached.controller.abort();
      this.cache.delete(key);
    }

    while (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.cache.get(oldestKey)?.controller.abort();
      this.cache.delete(oldestKey);
    }

    const controller = new AbortController();
    const promise = this.resolveFresh(
      candidate,
      controller.signal,
      profile,
    ).catch((error: unknown) => {
      if (this.cache.get(key)?.promise === promise) this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, { createdAt: now, controller, promise });
    return waitForCaller(promise, signal);
  }

  invalidate(candidate: Candidate, profile: MediaProfile): void {
    const key = cacheKey(candidate, profile);
    this.cache.get(key)?.controller.abort();
    this.cache.delete(key);
  }

  close(): void {
    for (const entry of this.cache.values()) entry.controller.abort();
    this.cache.clear();
  }

  private async resolveFresh(
    candidate: Candidate,
    signal: AbortSignal,
    profile: MediaProfile,
  ): Promise<ResolvedMedia> {
    if (candidate.source === "bbc") {
      return resolveBbcDirect(candidate, profile);
    }

    if (candidate.source === "archive") {
      return resolveArchiveDirect(candidate, signal, profile);
    }

    if (candidate.source === "youtube") {
      try {
        return await resolveYoutubeDirect(candidate, signal, profile);
      } catch (error) {
        if (signal.aborted) throw new Error("aborted");
        if (profile === "preview") {
          throw new Error(
            error instanceof Error
              ? error.message
              : "YouTube preview is unavailable.",
          );
        }
        console.warn(
          "[download] fast YouTube stream unavailable; falling back to yt-dlp",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const result = await runProcess(
      this.ytDlpPath,
      [
        "--skip-download",
        "--no-playlist",
        "--no-warning",
        "--no-update",
        "--socket-timeout",
        "15",
        "-f",
        DIRECT_AUDIO_FORMAT,
        "--print",
        "preview:url=%(url)s",
        "--print",
        "preview:ext=%(ext)s",
        "--print",
        "preview:duration=%(duration)s",
        "--print",
        "preview:headers=%(http_headers)j",
        candidate.url,
      ],
      signal,
    );

    if (signal.aborted) throw new Error("aborted");
    if (result.code !== 0) {
      throw new Error(
        `Could not prepare preview (yt-dlp exit ${result.code}).\n${result.stderr.slice(-600)}`,
      );
    }
    return parseResolvedMediaOutput(result.stdout);
  }
}
