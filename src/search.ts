import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { URL } from "node:url";

import { archiveIdFromUrl } from "./detect.js";
import { durationFromArchiveFiles } from "./media.js";
import type {
  Candidate,
  ItemKind,
  MediaSource,
  OpenverseProvider,
} from "./types.js";
import { runProcess } from "./process.js";

const SEARCH_LIMIT = 5;
const SEARCH_TIMEOUT_MS = 12_000;
const SEP = "\t";
const BBC_SEARCH_URL =
  "https://sound-effects-api.bbcrewind.co.uk/api/sfx/search";
const ARCHIVE_SEARCH_URL = "https://archive.org/advancedsearch.php";
const ARCHIVE_METADATA_URL = "https://archive.org/metadata";
const OPENVERSE_AUDIO_SEARCH_URL = "https://api.openverse.org/v1/audio/";
const OPENVERSE_USER_AGENT =
  "Online-Audio/0.3 (Ableton Live extension; +https://github.com/)";
const OPENVERSE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENVERSE_PROVIDERS = [
  "freesound",
  "jamendo",
  "wikimedia_audio",
] as const;

const PRINT_FMT = [
  "%(id)s",
  "%(title)s",
  "%(duration)s",
  "%(uploader)s",
  "%(webpage_url)s",
  "%(channel)s",
  "%(artist)s",
].join(SEP);

function parseDuration(raw: string): number | null {
  if (!raw || raw === "NA" || raw === "None") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function parseLine(
  line: string,
  source: MediaSource,
  rank: number,
): Candidate | null {
  const parts = line.split(SEP);
  if (parts.length < 5) return null;
  const [id, title, duration, uploader, webpageUrl, channel, artist] = parts;
  if (!id || id === "NA") return null;
  const url =
    webpageUrl && webpageUrl !== "NA"
      ? webpageUrl
      : source === "youtube"
        ? `https://www.youtube.com/watch?v=${id}`
        : webpageUrl || "";
  if (!url) return null;

  const artists: string[] = [];
  if (artist && artist !== "NA") {
    artists.push(
      ...artist
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
    );
  }

  return {
    id,
    url,
    title: title && title !== "NA" ? title : id,
    artists,
    album: null,
    durationS: parseDuration(duration ?? ""),
    source,
    channel:
      (channel && channel !== "NA" ? channel : null) ??
      (uploader && uploader !== "NA" ? uploader : null),
    searchRank: rank,
  };
}

/** Settle when `signal` aborts, even if `work` ignores AbortSignal. */
function settleOnAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => T | Promise<T>,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve(onAbort());
  return new Promise<T>((resolve, reject) => {
    const onAbortEvent = () => {
      Promise.resolve(onAbort()).then(resolve, reject);
    };
    signal.addEventListener("abort", onAbortEvent, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbortEvent);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbortEvent);
        reject(err);
      },
    );
  });
}

/** Hard deadline that does not rely on fetch honoring AbortSignal. */
function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
  signal?: AbortSignal,
): Promise<T> {
  return settleOnAbort(
    new Promise<T>((resolve) => {
      const t = setTimeout(() => resolve(fallback), ms);
      work.then(
        (value) => {
          clearTimeout(t);
          resolve(value);
        },
        () => {
          clearTimeout(t);
          resolve(fallback);
        },
      );
    }),
    signal,
    () => fallback,
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("aborted");
}

/** Extract a single-video id from common YouTube URL shapes. */
export function youtubeVideoIdFromUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  const asVideoId = (id: string | null | undefined): string | null => {
    // Video ids are exactly 11 chars; playlist ids are longer (e.g. PL…).
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    return id;
  };
  if (host === "youtu.be") {
    return asVideoId(u.pathname.split("/").filter(Boolean)[0] ?? "");
  }
  if (
    host !== "youtube.com" &&
    host !== "m.youtube.com" &&
    host !== "music.youtube.com"
  ) {
    return null;
  }
  const fromQuery = asVideoId(u.searchParams.get("v"));
  if (fromQuery) return fromQuery;
  const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/);
  return asVideoId(m?.[1]);
}

export function isYoutubePlaylistUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (
      host !== "youtube.com" &&
      host !== "m.youtube.com" &&
      host !== "music.youtube.com" &&
      host !== "youtu.be"
    ) {
      return false;
    }
    if (u.pathname.includes("/playlist")) return true;
    const list = u.searchParams.get("list");
    if (list && !youtubeVideoIdFromUrl(raw)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Fast title/author via Innertube player (same stack as search). */
async function resolveYouTubeInnertube(
  videoId: string,
  preferMusicHost: boolean,
  signal?: AbortSignal,
): Promise<Candidate | null> {
  throwIfAborted(signal);
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  signal?.addEventListener("abort", onOuter, { once: true });
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
        body: JSON.stringify({
          context: {
            client: {
              hl: "en",
              gl: "US",
              clientName: "WEB",
              clientVersion: "2.20250312.00.00",
            },
          },
          videoId,
        }),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      videoDetails?: {
        title?: string;
        author?: string;
        lengthSeconds?: string;
        videoId?: string;
      };
    };
    const details = data.videoDetails;
    if (!details?.title) return null;
    const watchUrl = preferMusicHost
      ? `https://music.youtube.com/watch?v=${videoId}`
      : `https://www.youtube.com/watch?v=${videoId}`;
    const durationS = details.lengthSeconds
      ? Number(details.lengthSeconds)
      : null;
    return {
      id: details.videoId || videoId,
      url: watchUrl,
      title: details.title.trim(),
      artists: details.author ? [details.author] : [],
      album: null,
      durationS: Number.isFinite(durationS) ? durationS : null,
      source: "youtube",
      channel: details.author ?? null,
      searchRank: 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuter);
  }
}

/** Fast title/author lookup — avoids spawning yt-dlp for watch URLs. */
async function resolveYouTubeOEmbed(
  videoId: string,
  preferMusicHost: boolean,
  signal?: AbortSignal,
): Promise<Candidate | null> {
  throwIfAborted(signal);
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  signal?.addEventListener("abort", onOuter, { once: true });
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const watchUrl = preferMusicHost
      ? `https://music.youtube.com/watch?v=${videoId}`
      : `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      {
        signal: ctrl.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      title?: string;
      author_name?: string;
    };
    return {
      id: videoId,
      url: watchUrl,
      title: data.title?.trim() || videoId,
      artists: data.author_name ? [data.author_name] : [],
      album: null,
      durationS: null,
      source: "youtube",
      channel: data.author_name ?? null,
      searchRank: 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuter);
  }
}

function runsText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const o = node as { simpleText?: string; runs?: Array<{ text?: string }> };
  if (o.simpleText) return o.simpleText;
  if (Array.isArray(o.runs)) return o.runs.map((r) => r.text ?? "").join("");
  return "";
}

function parseLengthText(raw: string): number | null {
  const parts = raw
    .trim()
    .split(":")
    .map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 1) return parts[0]!;
  return null;
}

function collectVideoRenderers(node: unknown, out: unknown[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectVideoRenderers(item, out);
    return;
  }
  const o = node as Record<string, unknown>;
  if (o.videoRenderer) out.push(o.videoRenderer);
  for (const v of Object.values(o)) collectVideoRenderers(v, out);
}

/** Fast YouTube search via Innertube (no yt-dlp spawn). */
async function searchYouTubeInnertube(
  query: string,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  throwIfAborted(signal);
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  signal?.addEventListener("abort", onOuter, { once: true });
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
      {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
        body: JSON.stringify({
          context: {
            client: {
              hl: "en",
              gl: "US",
              clientName: "WEB",
              clientVersion: "2.20250312.00.00",
            },
          },
          query,
        }),
      },
    );
    if (!res.ok) throw new Error(`YouTube search HTTP ${res.status}`);
    const data: unknown = await res.json();
    const renderers: unknown[] = [];
    collectVideoRenderers(data, renderers);
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const raw of renderers) {
      if (candidates.length >= SEARCH_LIMIT) break;
      const v = raw as {
        videoId?: string;
        title?: unknown;
        lengthText?: unknown;
        ownerText?: unknown;
        shortBylineText?: unknown;
      };
      const id = v.videoId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const channel =
        runsText(v.ownerText) || runsText(v.shortBylineText) || null;
      candidates.push({
        id,
        url: `https://www.youtube.com/watch?v=${id}`,
        title: runsText(v.title) || id,
        artists: [],
        album: null,
        durationS: parseLengthText(runsText(v.lengthText)),
        source: "youtube",
        channel,
        searchRank: candidates.length,
      });
    }
    return candidates;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuter);
  }
}

export async function searchYouTube(
  _ytDlpPath: string,
  query: string,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  // Prefer HTTP search only — spawning yt-dlp for search often hangs in Live.
  return withDeadline(
    searchYouTubeInnertube(query, signal).catch((err: unknown) => {
      console.error("[search youtube]", err);
      return [] as Candidate[];
    }),
    SEARCH_TIMEOUT_MS,
    [],
    signal,
  );
}

function collectMusicListItems(node: unknown, out: unknown[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectMusicListItems(item, out);
    return;
  }
  const o = node as Record<string, unknown>;
  if (o.musicResponsiveListItemRenderer) {
    out.push(o.musicResponsiveListItemRenderer);
  }
  for (const v of Object.values(o)) collectMusicListItems(v, out);
}

function musicItemVideoId(item: Record<string, unknown>): string | null {
  const playlist = item.playlistItemData as { videoId?: string } | undefined;
  if (playlist?.videoId) return playlist.videoId;
  const overlay = item.overlay as
    | {
        musicItemThumbnailOverlayRenderer?: {
          content?: {
            musicPlayButtonRenderer?: {
              playNavigationEndpoint?: { watchEndpoint?: { videoId?: string } };
            };
          };
        };
      }
    | undefined;
  return (
    overlay?.musicItemThumbnailOverlayRenderer?.content
      ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint
      ?.videoId ?? null
  );
}

function musicItemFlexTexts(item: Record<string, unknown>): string[] {
  const cols = item.flexColumns;
  if (!Array.isArray(cols)) return [];
  return cols.map((col) => {
    const text = (
      col as {
        musicResponsiveListItemFlexColumnRenderer?: { text?: unknown };
      }
    ).musicResponsiveListItemFlexColumnRenderer?.text;
    return runsText(text);
  });
}

function parseMusicSecondary(secondary: string): {
  artists: string[];
  album: string | null;
  durationS: number | null;
} {
  // "Artist • Album • 3:22" or "Artist • 3:22"
  const parts = secondary
    .split("•")
    .map((p) => p.trim())
    .filter(Boolean);
  let durationS: number | null = null;
  if (parts.length > 0) {
    const maybeDur = parseLengthText(parts[parts.length - 1]!);
    if (maybeDur != null) {
      durationS = maybeDur;
      parts.pop();
    }
  }
  const artists =
    parts.length > 0
      ? parts[0]!
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean)
      : [];
  const album = parts.length > 1 ? parts[1]! : null;
  return { artists, album, durationS };
}

/** Official-catalog search via YouTube Music (WEB_REMIX), songs filter. */
async function searchYouTubeMusicInnertube(
  query: string,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  throwIfAborted(signal);
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  signal?.addEventListener("abort", onOuter, { once: true });
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      "https://music.youtube.com/youtubei/v1/search?prettyPrint=false",
      {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Origin: "https://music.youtube.com",
          Referer: "https://music.youtube.com/",
        },
        body: JSON.stringify({
          context: {
            client: {
              hl: "en",
              gl: "US",
              clientName: "WEB_REMIX",
              clientVersion: "1.20250312.01.00",
            },
          },
          query,
          // Songs-only filter (same param used by ytmusicapi).
          params: "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D",
        }),
      },
    );
    if (!res.ok) throw new Error(`YouTube Music search HTTP ${res.status}`);
    const data: unknown = await res.json();
    const items: unknown[] = [];
    collectMusicListItems(data, items);
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const raw of items) {
      if (candidates.length >= SEARCH_LIMIT) break;
      const item = raw as Record<string, unknown>;
      const id = musicItemVideoId(item);
      if (!id || seen.has(id)) continue;
      const cols = musicItemFlexTexts(item);
      const title = cols[0]?.trim();
      if (!title) continue;
      seen.add(id);
      const secondary = parseMusicSecondary(cols[1] || "");
      candidates.push({
        id,
        url: `https://music.youtube.com/watch?v=${id}`,
        title,
        artists: secondary.artists,
        album: secondary.album,
        durationS: secondary.durationS,
        source: "youtube",
        channel:
          secondary.artists[0] != null
            ? `${secondary.artists[0]} - Topic`
            : null,
        searchRank: candidates.length,
      });
    }
    return candidates;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuter);
  }
}

export async function searchYouTubeMusic(
  query: string,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  return withDeadline(
    searchYouTubeMusicInnertube(query, signal).catch((err: unknown) => {
      console.error("[search youtube music]", err);
      return [] as Candidate[];
    }),
    SEARCH_TIMEOUT_MS,
    [],
    signal,
  );
}

let scClientIdMemory: string | null = null;

async function getSoundCloudClientId(
  storageDir?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (scClientIdMemory) return scClientIdMemory;

  const cacheFile = storageDir
    ? path.join(storageDir, "soundcloud-client-id.txt")
    : null;
  if (cacheFile) {
    try {
      const cached = (await fsp.readFile(cacheFile, "utf8")).trim();
      if (cached.length >= 20) {
        scClientIdMemory = cached;
        return cached;
      }
    } catch {
      /* miss */
    }
  }

  throwIfAborted(signal);
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  signal?.addEventListener("abort", onOuter, { once: true });
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const page = await fetch("https://soundcloud.com", {
      signal: ctrl.signal,
    }).then((r) => r.text());
    const scripts = [
      ...page.matchAll(/src="(https:\/\/[^"]+sndcdn\.com\/assets\/[^"]+\.js)"/g),
    ].map((m) => m[1]!);
    for (const url of scripts.slice(-8)) {
      throwIfAborted(signal);
      const js = await fetch(url, { signal: ctrl.signal }).then((r) =>
        r.text(),
      );
      const m =
        js.match(/client_id:"([A-Za-z0-9]{20,})"/) ||
        js.match(/client_id\s*:\s*"([A-Za-z0-9]{20,})"/);
      if (m?.[1]) {
        scClientIdMemory = m[1];
        if (cacheFile) {
          await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
          await fsp.writeFile(cacheFile, m[1], "utf8");
        }
        return m[1];
      }
    }
    throw new Error("Could not obtain SoundCloud client id");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuter);
  }
}

interface ScTrack {
  id: number;
  title?: string;
  permalink_url?: string;
  duration?: number;
  user?: { username?: string };
  publisher_metadata?: { artist?: string };
}

export async function searchSoundCloud(
  query: string,
  opts?: { signal?: AbortSignal; storageDir?: string },
): Promise<Candidate[]> {
  const work = (async () => {
    const clientId = await getSoundCloudClientId(
      opts?.storageDir,
      opts?.signal,
    );
    throwIfAborted(opts?.signal);
    const ctrl = new AbortController();
    const onOuter = () => ctrl.abort();
    opts?.signal?.addEventListener("abort", onOuter, { once: true });
    const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
    try {
      const url =
        `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}` +
        `&client_id=${clientId}&limit=${SEARCH_LIMIT}&app_locale=en`;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`SoundCloud search HTTP ${res.status}`);
      const data = (await res.json()) as { collection?: ScTrack[] };
      const candidates: Candidate[] = [];
      for (const track of data.collection ?? []) {
        if (!track.id || !track.permalink_url) continue;
        const artist =
          track.publisher_metadata?.artist || track.user?.username || undefined;
        candidates.push({
          id: String(track.id),
          url: track.permalink_url,
          title: track.title || String(track.id),
          artists: artist ? [artist] : [],
          album: null,
          durationS:
            typeof track.duration === "number"
              ? Math.round(track.duration / 1000)
              : null,
          source: "soundcloud",
          channel: track.user?.username ?? null,
          searchRank: candidates.length,
        });
      }
      return candidates;
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onOuter);
    }
  })().catch((err: unknown) => {
    console.error("[search soundcloud]", err);
    return [] as Candidate[];
  });

  return withDeadline(work, SEARCH_TIMEOUT_MS + 2_000, [], opts?.signal);
}

interface BbcSoundEffect {
  id?: string;
  description?: string;
  duration?: number;
  categories?: Array<{ className?: string }>;
  technicalMetadata?: { duration?: string };
}

function bbcDurationS(effect: BbcSoundEffect): number | null {
  const technicalDuration = Number(effect.technicalMetadata?.duration);
  if (Number.isFinite(technicalDuration) && technicalDuration > 0) {
    return technicalDuration;
  }
  if (
    typeof effect.duration === "number" &&
    Number.isFinite(effect.duration) &&
    effect.duration > 0
  ) {
    return effect.duration / 1000;
  }
  return null;
}

/**
 * Search BBC Sound Effects through the same unauthenticated JSON endpoint used
 * by its website. This is not a documented public API, so failures are isolated
 * from the other providers.
 */
export async function searchBbc(
  query: string,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const work = (async () => {
    throwIfAborted(signal);
    const ctrl = new AbortController();
    const onOuter = () => ctrl.abort();
    signal?.addEventListener("abort", onOuter, { once: true });
    const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
    try {
      const criteria = {
        from: 0,
        size: SEARCH_LIMIT,
        query,
        tags: null,
        categories: null,
        durations: null,
        continents: null,
        sortBy: null,
        source: null,
        recordist: null,
        habitat: null,
      };
      const res = await fetch(BBC_SEARCH_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ criteria }),
      });
      if (!res.ok) throw new Error(`BBC search HTTP ${res.status}`);
      const data = (await res.json()) as { results?: BbcSoundEffect[] };
      const candidates: Candidate[] = [];
      for (const effect of data.results ?? []) {
        if (candidates.length >= SEARCH_LIMIT) break;
        const id = effect.id?.trim();
        const title = effect.description?.trim();
        if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || !title) continue;
        candidates.push({
          id,
          url: `https://sound-effects.bbcrewind.co.uk/search?q=${encodeURIComponent(id)}`,
          title,
          artists: [],
          album: effect.categories?.[0]?.className ?? null,
          durationS: bbcDurationS(effect),
          source: "bbc",
          channel: "BBC Sound Effects",
          searchRank: candidates.length,
        });
      }
      return candidates;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuter);
    }
  })().catch((err: unknown) => {
    console.error("[search bbc]", err);
    return [] as Candidate[];
  });

  return withDeadline(work, SEARCH_TIMEOUT_MS + 2_000, [], signal);
}

interface ArchiveSearchDoc {
  identifier?: string;
  title?: string | string[];
  creator?: string | string[];
  runtime?: string | string[];
  collection?: string | string[];
  subject?: string | string[];
}

/**
 * Spoken-word / non-musical catalogs to drop from Archive search:
 * audiobooks, podcasts, old radio, sermons, lectures, religious recitation.
 */
const ARCHIVE_EXCLUDED_COLLECTIONS = [
  "librivoxaudio",
  "podcasts",
  "podcasts_miscellaneous",
  "oldtimeradio",
  "radioprograms",
  "theoldtimeradio",
  "ytjdradio",
  "audio_bookspoetry",
  "audio_books",
  "audio_sermons",
  "audio_islamic",
  "audio_religion",
  "sermonindex",
  "sermonindex_audio",
  "newsletters",
  "newsletters_inbox",
  "magazine_rack",
  "attentionkmartshoppers",
  "folksoundomy_podfic",
  "audio_news",
  "hifidelity_potpourri",
  "ucberkeley-webcast",
] as const;

const ARCHIVE_EXCLUDED_COLLECTION_PREFIXES = [
  "podcast",
  "librivox",
  "oldtimeradio",
  "otr",
  "audio_book",
  "radioprogram",
  "sermon",
  "audio_sermon",
  "audio_islamic",
  "audio_religion",
  "newsletter",
  "audio_news",
  "podfic",
  "webcast",
] as const;

const ARCHIVE_EXCLUDED_SUBJECTS = [
  "podcast",
  "podcasts",
  "audiobook",
  "audiobooks",
  "librivox",
  "old time radio",
  "otr",
  "otrr",
  "spoken word",
  "lecture",
  "lectures",
  "sermon",
  "sermons",
  "speech",
  "speeches",
  "interview",
  "interviews",
  "radio drama",
  "text to speech",
  "quran",
  "qur'an",
  "bible",
] as const;

const ARCHIVE_SPOKEN_TEXT =
  /\b(spoken word|audiobook|podcast|lecture|lectures|sermon|sermons|speech|speeches|interview|interviews|radio drama|text to speech|quran|qur'?an|tafseer|bible in audio|audio bible|waz)\b/i;

function firstString(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") continue;
      const trimmed = item.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function stringList(value: string | string[] | undefined): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

const ARCHIVE_SFX_COLLECTIONS = new Set([
  "folksoundomy_effects",
]);

const ARCHIVE_MUSIC_COLLECTIONS = new Set([
  "netlabels",
  "audio_music",
  "78rpm",
  "etree",
  "live_music_archive",
  "hifidelity_soundtracks",
  "bandcamp",
]);

const ARCHIVE_SFX_TEXT =
  /\b(sound effects?|sound fx|sfx|foley|field recordings?|nature sounds?|white noise|pink noise|brown(?:ian)? noise|ambience|atmosphere|soundscape|rain sounds?|thunder|door slam|whoosh|impacts?)\b/i;

const ARCHIVE_MUSIC_TEXT =
  /\b(album|ep\b|single|concert|live at|live music|soundtrack|ost\b|remix|mixtape|discography|orchestra|symphony|songs?|hits|music|guitar|piano|jazz|rock|metal|hip[- ]?hop|techno|house music|netlabel|grateful dead|bollywood|hindi|tamil|punjabi|carnatic|hindustani|raga|bhajan|ghazal|indian classical)\b/i;

const ARCHIVE_SFX_SEARCH_CLAUSE =
  '(collection:(folksoundomy_effects) OR ' +
  'subject:("sound effect" OR "sound effects" OR foley OR "field recording" OR ' +
  '"field recordings" OR ambience OR soundscape OR "nature sounds") OR ' +
  'title:("sound effect" OR "sound effects" OR foley OR "field recording" OR ' +
  '"field recordings" OR ambience OR soundscape OR "nature sounds"))';

const ARCHIVE_MUSIC_SEARCH_CLAUSE =
  "(collection:(netlabels OR audio_music OR 78rpm OR etree OR " +
  "live_music_archive OR hifidelity_soundtracks OR bandcamp) OR " +
  'subject:(music OR album OR concert OR soundtrack OR remix OR jazz OR rock OR ' +
  '"hip hop" OR techno) OR ' +
  'title:(music OR album OR concert OR soundtrack OR remix OR jazz OR rock OR ' +
  '"hip hop" OR techno))';

/**
 * Classify Internet Archive audio as Music or Sound Effect from catalog cues.
 * Field recordings / SFX libraries → sound-effect; concerts / netlabels → music.
 */
export function archiveItemKind(doc: {
  identifier?: string;
  title?: string | string[];
  collection?: string | string[];
  subject?: string | string[];
}): ItemKind {
  let sfxScore = 0;
  let musicScore = 0;

  for (const collection of stringList(doc.collection)) {
    const lower = collection.toLowerCase();
    if (lower.startsWith("fav-") || lower === "community") continue;
    if (ARCHIVE_SFX_COLLECTIONS.has(lower)) sfxScore += 4;
    if (ARCHIVE_MUSIC_COLLECTIONS.has(lower)) musicScore += 4;
    if (/(?:^|_)(?:effects?|sfx|foley|soundfx)(?:_|$)/.test(lower)) {
      sfxScore += 3;
    }
    if (
      /(?:^|_)(?:netlabels?|etree|concert|bandcamp|musica|soundtrack|discography|live_music)(?:_|$)/.test(
        lower,
      )
    ) {
      musicScore += 3;
    }
  }

  const title = firstString(doc.title) || "";
  const subjects = stringList(doc.subject).join(" ");
  const blob = `${title} ${subjects} ${doc.identifier || ""}`;

  if (ARCHIVE_SFX_TEXT.test(blob)) sfxScore += 3;
  if (ARCHIVE_MUSIC_TEXT.test(blob)) musicScore += 3;

  // Explicit SFX packs in title/id win even inside music-ish collections.
  if (
    /\b(sound effects?|sound fx|sfx library|foley)\b/i.test(blob) ||
    /sound[_-]?effects?/i.test(doc.identifier || "")
  ) {
    sfxScore += 4;
  }

  // opensource_audio / ourmedia are mixed dumps. Only call something a sound
  // effect when SFX cues win; otherwise treat it as music (Bollywood uploads,
  // ragas, etc. often lack English "song" wording).
  if (sfxScore > musicScore) return "sound-effect";
  return "music";
}

/** True when an Archive hit is spoken-word (speech, sermon, podcast, radio, etc.). */
export function isExcludedArchiveDoc(doc: {
  identifier?: string;
  title?: string | string[];
  collection?: string | string[];
  subject?: string | string[];
}): boolean {
  const id = (doc.identifier || "").toLowerCase();
  if (
    id.includes("librivox") ||
    id.startsWith("otrr_") ||
    id.includes("oldtimeradio") ||
    id.includes("podcast") ||
    id.includes("sermon") ||
    id.includes("lecture") ||
    /\bquran\b/.test(id) ||
    id.includes("quran")
  ) {
    return true;
  }

  for (const collection of stringList(doc.collection)) {
    const lower = collection.toLowerCase();
    if (lower.startsWith("fav-")) continue;
    if (
      (ARCHIVE_EXCLUDED_COLLECTIONS as readonly string[]).includes(lower) ||
      ARCHIVE_EXCLUDED_COLLECTION_PREFIXES.some((prefix) =>
        lower.startsWith(prefix),
      )
    ) {
      return true;
    }
  }

  for (const subject of stringList(doc.subject)) {
    const lower = subject.toLowerCase();
    if ((ARCHIVE_EXCLUDED_SUBJECTS as readonly string[]).includes(lower)) {
      return true;
    }
    if (
      lower.includes("old time radio") ||
      lower.includes("audiobook") ||
      lower.includes("podcast") ||
      lower.includes("librivox") ||
      lower.includes("spoken word") ||
      lower.includes("lecture") ||
      lower.includes("sermon") ||
      lower.includes("interview") ||
      lower.includes("text to speech")
    ) {
      return true;
    }
  }

  const title = firstString(doc.title) || "";
  const blob = `${title} ${stringList(doc.subject).join(" ")} ${id}`;
  if (ARCHIVE_SPOKEN_TEXT.test(blob) || /\botrr?\b/i.test(title)) {
    return true;
  }

  return false;
}

/** Parse Internet Archive runtime strings like "3:45", "5:48.18", "1:02:03", or "90.5". */
export function parseArchiveRuntime(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
  const hms = text.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/);
  if (hms) {
    const hours = Number(hms[1]);
    const minutes = Number(hms[2]);
    const seconds = Number(hms[3]);
    if (![hours, minutes, seconds].every(Number.isFinite)) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }
  const ms = text.match(/^(\d+):(\d{1,2}(?:\.\d+)?)/);
  if (!ms) return null;
  const minutes = Number(ms[1]);
  const seconds = Number(ms[2]);
  if (![minutes, seconds].every(Number.isFinite)) return null;
  return minutes * 60 + seconds;
}

const ARCHIVE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/;
const ARCHIVE_USER_AGENT =
  "Online-Audio/0.3 (Ableton Live extension; +https://github.com/)";

function archiveSearchQuery(query: string, kind?: ItemKind): string {
  const words = query
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 8);
  const textQuery = words.length > 0 ? `${words.join(" ")} AND ` : "";
  const kindQuery =
    kind === "sound-effect"
      ? ` AND ${ARCHIVE_SFX_SEARCH_CLAUSE}`
      : kind === "music"
        ? ` AND ${ARCHIVE_MUSIC_SEARCH_CLAUSE}`
        : "";
  // Drop spoken-word catalogs that dominate download-sorted audio search.
  return (
    `${textQuery}mediatype:audio` +
    kindQuery +
    " AND NOT collection:(" +
    ARCHIVE_EXCLUDED_COLLECTIONS.join(" OR ") +
    ")" +
    " AND NOT subject:(" +
    ARCHIVE_EXCLUDED_SUBJECTS.map((subject) =>
      subject.includes(" ") ? `"${subject}"` : subject,
    ).join(" OR ") +
    ")"
  );
}

function isArchiveId(id: string): boolean {
  return ARCHIVE_ID_RE.test(id);
}

async function hydrateArchiveDuration(
  candidate: Candidate,
  signal: AbortSignal,
): Promise<Candidate> {
  if (candidate.durationS != null) return candidate;
  throwIfAborted(signal);
  try {
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
    if (!res.ok) return candidate;
    const data = (await res.json()) as {
      metadata?: { runtime?: string | string[] };
      files?: Array<{
        name?: string;
        format?: string;
        length?: string;
        size?: string;
        source?: string;
      }>;
    };
    const fromFiles = durationFromArchiveFiles(data.files ?? []);
    if (fromFiles != null) return { ...candidate, durationS: fromFiles };
    const fromRuntime = parseArchiveRuntime(firstString(data.metadata?.runtime));
    return fromRuntime != null
      ? { ...candidate, durationS: fromRuntime }
      : candidate;
  } catch {
    return candidate;
  }
}

export interface ArchiveSearchOptions {
  signal?: AbortSignal;
  kind?: ItemKind;
}

/**
 * Search Internet Archive audio through the public Advanced Search JSON API.
 * Failures stay isolated from the other providers.
 */
export async function searchArchive(
  query: string,
  opts: ArchiveSearchOptions = {},
): Promise<Candidate[]> {
  const work = (async () => {
    throwIfAborted(opts.signal);
    const ctrl = new AbortController();
    const onOuter = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onOuter, { once: true });
    const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
    try {
      // Build the query string explicitly. Some runtimes mishandle repeated
      // fl[] / sort[] keys from URLSearchParams.
      const q = encodeURIComponent(archiveSearchQuery(query, opts.kind));
      // Fetch extra rows so client-side spoken-word filtering can still fill
      // SEARCH_LIMIT after dropping mismatched and spoken-word leftovers.
      const rowMultiplier = opts.kind ? 8 : 4;
      const url =
        `${ARCHIVE_SEARCH_URL}?q=${q}` +
        `&output=json&rows=${SEARCH_LIMIT * rowMultiplier}&page=1` +
        `&fl[]=identifier,title,creator,runtime,collection,subject` +
        `&sort[]=${encodeURIComponent("downloads desc")}`;
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": ARCHIVE_USER_AGENT,
        },
      });
      if (!res.ok) throw new Error(`Internet Archive search HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") || "";
      const body = await res.text();
      if (!contentType.includes("json") && !body.trimStart().startsWith("{")) {
        throw new Error("Internet Archive search returned a non-JSON response.");
      }
      const data = JSON.parse(body) as {
        response?: { docs?: ArchiveSearchDoc[] };
      };
      const candidates: Candidate[] = [];
      for (const doc of data.response?.docs ?? []) {
        if (candidates.length >= SEARCH_LIMIT) break;
        if (isExcludedArchiveDoc(doc)) continue;
        const kind = archiveItemKind(doc);
        if (opts.kind && kind !== opts.kind) continue;
        const id = doc.identifier?.trim();
        const title = firstString(doc.title);
        if (!id || !isArchiveId(id) || !title) continue;
        const creator = firstString(doc.creator);
        candidates.push({
          id,
          url: `https://archive.org/details/${id}`,
          title,
          artists: creator ? [creator] : [],
          album: null,
          durationS: parseArchiveRuntime(firstString(doc.runtime)),
          source: "archive",
          channel: "Internet Archive",
          searchRank: candidates.length,
          kind,
        });
      }
      // Search rarely includes runtime; read file lengths from item metadata.
      return await Promise.all(
        candidates.map((candidate) =>
          hydrateArchiveDuration(candidate, ctrl.signal),
        ),
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuter);
    }
  })().catch((err: unknown) => {
    console.error("[search archive]", err);
    return [] as Candidate[];
  });

  return withDeadline(work, SEARCH_TIMEOUT_MS + 2_000, [], opts.signal);
}

interface OpenverseAudioResult {
  id?: string;
  title?: string;
  foreign_landing_url?: string;
  creator?: string | null;
  provider?: string;
  source?: string;
  category?: string | null;
  duration?: number | null;
  mature?: boolean;
}

export function openverseProvider(
  value: string | null | undefined,
): OpenverseProvider | null {
  if (
    value === "freesound" ||
    value === "jamendo" ||
    value === "wikimedia_audio"
  ) {
    return value;
  }
  return null;
}

export function openverseProviderLabel(provider: OpenverseProvider): string {
  switch (provider) {
    case "freesound":
      return "Freesound";
    case "jamendo":
      return "Jamendo";
    case "wikimedia_audio":
      return "Wikimedia Commons";
  }
}

export function openverseItemKind(
  provider: OpenverseProvider,
  category: string | null | undefined,
): ItemKind {
  if (provider === "freesound") return "sound-effect";
  if (provider === "jamendo") return "music";
  const cat = (category ?? "").toLowerCase();
  if (
    /\b(sound.?effect|effects?|foley|ambient|field.?recording)\b/.test(cat)
  ) {
    return "sound-effect";
  }
  return "music";
}

function openverseDurationS(durationMs: number | null | undefined): number | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return null;
  }
  if (durationMs <= 0) return null;
  return durationMs / 1000;
}

/**
 * Search openly licensed audio through the public Openverse API (Freesound,
 * Jamendo, Wikimedia Commons). Failures stay isolated from other providers.
 */
export async function searchOpenverse(
  query: string,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const work = (async () => {
    throwIfAborted(signal);
    const ctrl = new AbortController();
    const onOuter = () => ctrl.abort();
    signal?.addEventListener("abort", onOuter, { once: true });
    const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
    try {
      // Build the query string explicitly. Ableton's Extension Host does not
      // provide the web URLSearchParams global.
      const url =
        `${OPENVERSE_AUDIO_SEARCH_URL}?q=${encodeURIComponent(query)}` +
        `&page_size=${SEARCH_LIMIT * 3}` +
        `&source=${encodeURIComponent(OPENVERSE_PROVIDERS.join(","))}` +
        `&mature=false`;
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": OPENVERSE_USER_AGENT,
        },
      });
      if (!res.ok) throw new Error(`Openverse search HTTP ${res.status}`);
      const data = (await res.json()) as { results?: OpenverseAudioResult[] };
      const candidates: Candidate[] = [];
      for (const item of data.results ?? []) {
        if (candidates.length >= SEARCH_LIMIT * 3) break;
        if (item.mature) continue;
        const id = item.id?.trim();
        const title = item.title?.trim();
        const landing = item.foreign_landing_url?.trim();
        const provider = openverseProvider(item.source ?? item.provider);
        if (!id || !OPENVERSE_UUID_RE.test(id) || !title || !landing || !provider) {
          continue;
        }
        let landingUrl: URL;
        try {
          landingUrl = new URL(landing);
        } catch {
          continue;
        }
        if (landingUrl.protocol !== "https:") continue;
        const creator = item.creator?.trim();
        candidates.push({
          id,
          url: landingUrl.toString(),
          title,
          artists: creator ? [creator] : [],
          album: openverseProviderLabel(provider),
          durationS: openverseDurationS(item.duration),
          source: "openverse",
          channel: openverseProviderLabel(provider),
          searchRank: candidates.length,
          kind: openverseItemKind(provider, item.category),
          provider,
        });
      }
      return candidates;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuter);
    }
  })().catch((err: unknown) => {
    console.error("[search openverse]", err);
    return [] as Candidate[];
  });

  return withDeadline(work, SEARCH_TIMEOUT_MS + 2_000, [], signal);
}

export async function resolveArchiveCandidate(
  id: string,
  signal?: AbortSignal,
): Promise<Candidate> {
  if (!isArchiveId(id)) {
    throw new Error("Invalid Internet Archive id.");
  }
  throwIfAborted(signal);
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  signal?.addEventListener("abort", onOuter, { once: true });
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${ARCHIVE_METADATA_URL}/${encodeURIComponent(id)}`, {
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": ARCHIVE_USER_AGENT,
      },
    });
    if (!res.ok) {
      throw new Error(`Internet Archive metadata HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      metadata?: {
        identifier?: string;
        title?: string | string[];
        creator?: string | string[];
        runtime?: string | string[];
        collection?: string | string[];
        subject?: string | string[];
      };
      files?: Array<{
        name?: string;
        format?: string;
        length?: string;
        size?: string;
        source?: string;
      }>;
    };
    const meta = data.metadata ?? {};
    const resolvedId = meta.identifier?.trim() || id;
    if (!isArchiveId(resolvedId)) {
      throw new Error("Invalid Internet Archive id.");
    }
    const title = firstString(meta.title) || resolvedId;
    const creator = firstString(meta.creator);
    return {
      id: resolvedId,
      url: `https://archive.org/details/${resolvedId}`,
      title,
      artists: creator ? [creator] : [],
      album: null,
      durationS:
        durationFromArchiveFiles(data.files ?? []) ??
        parseArchiveRuntime(firstString(meta.runtime)),
      source: "archive",
      channel: "Internet Archive",
      searchRank: 0,
      kind: archiveItemKind({
        identifier: resolvedId,
        title,
        ...(meta.collection != null ? { collection: meta.collection } : {}),
        ...(meta.subject != null ? { subject: meta.subject } : {}),
      }),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuter);
  }
}

/** Prefer YouTube Music ids when the same video appears in regular YouTube too. */
export function mergeSearchResults(
  youtubeMusic: Candidate[],
  youtube: Candidate[],
  soundcloud: Candidate[],
  bbc: Candidate[] = [],
  archive: Candidate[] = [],
  openverse: Candidate[] = [],
): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of [
    ...youtubeMusic,
    ...youtube,
    ...soundcloud,
    ...bbc,
    ...archive,
    ...openverse,
  ]) {
    const key = `${c.source}:${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export async function searchBoth(
  ytDlpPath: string,
  query: string,
  opts?: { signal?: AbortSignal; storageDir?: string },
): Promise<Candidate[]> {
  throwIfAborted(opts?.signal);
  const work = Promise.all([
    searchYouTubeMusic(query, opts?.signal),
    searchYouTube(ytDlpPath, query, opts?.signal),
    searchSoundCloud(query, opts),
    searchBbc(query, opts?.signal),
    searchArchive(query, opts?.signal ? { signal: opts.signal } : {}),
    searchOpenverse(query, opts?.signal),
  ]).then(([ytm, yt, sc, bbc, archive, openverse]) =>
    mergeSearchResults(ytm, yt, sc, bbc, archive, openverse),
  );

  // Cancel must settle the progress dialog even if fetch ignores AbortSignal.
  return settleOnAbort(work, opts?.signal, () => {
    throw new Error("aborted");
  });
}

export async function resolveUrl(
  ytDlpPath: string,
  url: string,
  source: MediaSource,
  opts?: { signal?: AbortSignal; storageDir?: string },
): Promise<Candidate> {
  throwIfAborted(opts?.signal);

  if (source === "youtube") {
    if (isYoutubePlaylistUrl(url)) {
      throw new Error(
        "Playlist URLs are not supported. Paste a link to a single video.",
      );
    }
    const videoId = youtubeVideoIdFromUrl(url);
    const preferMusic = url.includes("music.youtube.com");
    if (!videoId) {
      throw new Error(
        "Could not find a video in that URL. Paste a link to a single video.",
      );
    }
    const viaPlayer = await resolveYouTubeInnertube(
      videoId,
      preferMusic,
      opts?.signal,
    );
    if (viaPlayer) return viaPlayer;
    const viaOembed = await resolveYouTubeOEmbed(
      videoId,
      preferMusic,
      opts?.signal,
    );
    if (viaOembed) return viaOembed;
    // Never block on yt-dlp for parseable watch URLs.
    return {
      id: videoId,
      url: preferMusic
        ? `https://music.youtube.com/watch?v=${videoId}`
        : `https://www.youtube.com/watch?v=${videoId}`,
      title: videoId,
      artists: [],
      album: null,
      durationS: null,
      source: "youtube",
      channel: null,
      searchRank: 0,
    };
  }

  if (source === "archive") {
    const id = archiveIdFromUrl(url);
    if (!id) {
      throw new Error(
        "Could not find an item in that URL. Paste an archive.org details link.",
      );
    }
    return resolveArchiveCandidate(id, opts?.signal);
  }

  if (source === "soundcloud") {
    try {
      const clientId = await getSoundCloudClientId(
        opts?.storageDir,
        opts?.signal,
      );
      const ctrl = new AbortController();
      const onOuter = () => ctrl.abort();
      opts?.signal?.addEventListener("abort", onOuter, { once: true });
      const timer = setTimeout(() => ctrl.abort(), 12_000);
      try {
        const res = await fetch(
          `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${clientId}`,
          { signal: ctrl.signal },
        );
        if (res.ok) {
          const track = (await res.json()) as ScTrack;
          if (track.id) {
            const artist =
              track.publisher_metadata?.artist ||
              track.user?.username ||
              undefined;
            return {
              id: String(track.id),
              url: track.permalink_url || url,
              title: track.title || String(track.id),
              artists: artist ? [artist] : [],
              album: null,
              durationS:
                typeof track.duration === "number"
                  ? Math.round(track.duration / 1000)
                  : null,
              source: "soundcloud",
              channel: track.user?.username ?? null,
              searchRank: 0,
            };
          }
        }
      } finally {
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onOuter);
      }
    } catch (err) {
      if (err instanceof Error && err.message === "aborted") throw err;
      console.warn("[resolve soundcloud] falling back to yt-dlp", err);
    }
  }

  throwIfAborted(opts?.signal);
  const result = await runProcess(
    ytDlpPath,
    [
      "--skip-download",
      "--no-playlist",
      "--no-warning",
      "--no-update",
      "--socket-timeout",
      "15",
      "--print",
      PRINT_FMT,
      url,
    ],
    opts?.signal,
  );
  throwIfAborted(opts?.signal);
  if (result.code !== 0) {
    throw new Error(
      `Could not resolve URL (yt-dlp exit ${result.code}).\n${result.stderr.slice(-600)}`,
    );
  }
  const line = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) throw new Error("No metadata returned for URL");
  const c = parseLine(line, source, 0);
  if (!c) throw new Error("Failed to parse URL metadata");
  c.url = url;
  return c;
}
