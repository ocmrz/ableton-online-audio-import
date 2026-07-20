import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { URL } from "node:url";

import type { Candidate, MediaSource } from "./types.js";
import { runProcess } from "./process.js";

const SEARCH_LIMIT = 5;
const SEARCH_TIMEOUT_MS = 12_000;
const SEP = "\t";
const BBC_SEARCH_URL =
  "https://sound-effects-api.bbcrewind.co.uk/api/sfx/search";

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

/** Prefer YouTube Music ids when the same video appears in regular YouTube too. */
export function mergeSearchResults(
  youtubeMusic: Candidate[],
  youtube: Candidate[],
  soundcloud: Candidate[],
  bbc: Candidate[] = [],
): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of [...youtubeMusic, ...youtube, ...soundcloud, ...bbc]) {
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
  ]).then(([ytm, yt, sc, bbc]) => mergeSearchResults(ytm, yt, sc, bbc));

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
