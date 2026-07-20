import * as http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";

import { detectInput } from "./detect.js";
import { MediaResolver, type ResolvedMedia } from "./media.js";
import { rankCandidates } from "./rank.js";
import {
  mergeSearchResults,
  resolveUrl,
  searchBbc,
  searchSoundCloud,
  searchYouTube,
  searchYouTubeMusic,
} from "./search.js";
import type { Candidate } from "./types.js";
import { artistStr } from "./types.js";

export type Brand = "youtube" | "youtube-music" | "soundcloud" | "bbc";

export interface SearchServer {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

const MAX_REQUEST_BODY_BYTES = 32 * 1024;

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function candidateFromValue(value: unknown): Candidate {
  if (!value || typeof value !== "object") {
    throw new Error("Missing preview candidate.");
  }
  const raw = value as Record<string, unknown>;
  const source = raw.source;
  if (
    source !== "youtube" &&
    source !== "soundcloud" &&
    source !== "bbc"
  ) {
    throw new Error("Unsupported preview source.");
  }
  if (
    typeof raw.id !== "string" ||
    typeof raw.url !== "string" ||
    typeof raw.title !== "string"
  ) {
    throw new Error("Invalid preview candidate.");
  }

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(raw.url);
  } catch {
    throw new Error("Invalid preview URL.");
  }
  const host = sourceUrl.hostname.replace(/^www\./i, "").toLowerCase();
  const validHost =
    source === "youtube"
      ? host === "youtube.com" ||
        host === "m.youtube.com" ||
        host === "music.youtube.com" ||
        host === "youtu.be"
      : source === "soundcloud"
        ? host === "soundcloud.com" || host.endsWith(".soundcloud.com")
        : host === "sound-effects.bbcrewind.co.uk";
  if (!validHost || sourceUrl.protocol !== "https:") {
    throw new Error("Unsupported preview URL.");
  }

  return {
    id: raw.id,
    url: raw.url,
    title: raw.title,
    artists: Array.isArray(raw.artists)
      ? raw.artists.filter((artist): artist is string => typeof artist === "string")
      : [],
    album: typeof raw.album === "string" ? raw.album : null,
    durationS: typeof raw.durationS === "number" ? raw.durationS : null,
    source,
    channel: typeof raw.channel === "string" ? raw.channel : null,
    searchRank: typeof raw.searchRank === "number" ? raw.searchRank : 0,
  };
}

export function upstreamHeaders(
  media: ResolvedMedia,
  range: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const blocked = new Set([
    "accept-encoding",
    "connection",
    "content-length",
    "host",
    "range",
  ]);
  for (const [name, value] of Object.entries(media.httpHeaders)) {
    if (!blocked.has(name.toLowerCase())) headers[name] = value;
  }
  headers["Accept-Encoding"] = "identity";
  if (range) headers.Range = range;
  return headers;
}

async function proxyMedia(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  media: ResolvedMedia,
  signal: AbortSignal,
): Promise<void> {
  const method = req.method === "HEAD" ? "HEAD" : "GET";
  const upstream = await fetch(media.url, {
    method,
    headers: upstreamHeaders(media, req.headers.range),
    redirect: "follow",
    signal,
  });
  if (!upstream.ok) {
    throw new Error(`Preview stream returned HTTP ${upstream.status}.`);
  }

  const responseHeaders: Record<string, string> = {
    "Cache-Control": "no-store",
  };
  for (const name of [
    "accept-ranges",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  if (!responseHeaders["content-type"]) {
    responseHeaders["content-type"] = `audio/${media.ext}`;
  }

  res.writeHead(upstream.status, responseHeaders);
  if (method === "HEAD" || !upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) break;
      if (!res.write(Buffer.from(value))) await once(res, "drain");
    }
    if (!res.destroyed) res.end();
  } finally {
    reader.releaseLock();
  }
}

export function brandFor(c: Candidate): Brand {
  if (c.source === "bbc") return "bbc";
  if (c.source === "soundcloud") return "soundcloud";
  if (
    c.url.includes("music.youtube.com") ||
    (c.channel != null && c.channel.endsWith(" - Topic"))
  ) {
    return "youtube-music";
  }
  return "youtube";
}

function toItem(c: Candidate, score: number | null, notes: string) {
  return {
    id: c.id,
    title: c.title,
    subtitle: artistStr(c) || c.channel || c.source,
    source: c.source,
    brand: brandFor(c),
    type: c.source === "bbc" ? "sound-effect" : "song",
    durationS: c.durationS,
    score,
    notes,
    candidate: c,
  };
}

export async function startSearchServer(opts: {
  html: string;
  ytDlpPath: string;
  storageDir: string;
  mediaResolver: MediaResolver;
}): Promise<SearchServer> {
  const previewMedia = new Map<string, ResolvedMedia>();
  const activeRequests = new Set<AbortController>();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");

      if (
        req.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/index.html")
      ) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(opts.html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/search") {
        const q = (url.searchParams.get("q") || "").trim();

        if (!q) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ items: [] }));
          return;
        }

        const detected = detectInput(q);

        if (detected.kind === "url") {
          const one = await Promise.race([
            resolveUrl(opts.ytDlpPath, detected.url, detected.source, {
              storageDir: opts.storageDir,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("URL resolve timed out")),
                20_000,
              ),
            ),
          ]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ items: [toItem(one, null, "")] }));
          return;
        }

        const rankedQuery = detected.query;
        const [ytm, yt, sc, bbc] = await Promise.all([
          searchYouTubeMusic(rankedQuery).catch(() => [] as Candidate[]),
          searchYouTube(opts.ytDlpPath, rankedQuery).catch(
            () => [] as Candidate[],
          ),
          searchSoundCloud(rankedQuery, {
            storageDir: opts.storageDir,
          }).catch(() => [] as Candidate[]),
          searchBbc(rankedQuery).catch(() => [] as Candidate[]),
        ]);
        const ranked = rankCandidates(
          mergeSearchResults(ytm, yt, sc, bbc),
          rankedQuery,
        );
        const items = ranked.map((s) =>
          toItem(s.candidate, s.score, s.notes.slice(0, 2).join(", ")),
        );

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ items }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/preview") {
        const body = (await readJsonBody(req)) as { candidate?: unknown };
        const candidate = candidateFromValue(body?.candidate);
        const controller = new AbortController();
        activeRequests.add(controller);
        res.once("close", () => controller.abort());
        try {
          const media = await opts.mediaResolver.resolve(
            candidate,
            controller.signal,
          );
          if (res.destroyed) return;
          const token = randomUUID();
          previewMedia.set(token, media);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(
            JSON.stringify({
              mediaUrl: `/media/${token}`,
              durationS: media.durationS ?? candidate.durationS,
            }),
          );
        } finally {
          activeRequests.delete(controller);
        }
        return;
      }

      const mediaMatch = /^\/media\/([a-zA-Z0-9-]+)$/.exec(url.pathname);
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        mediaMatch?.[1]
      ) {
        const media = previewMedia.get(mediaMatch[1]);
        if (!media) {
          res.writeHead(404).end("Preview expired");
          return;
        }
        const controller = new AbortController();
        activeRequests.add(controller);
        res.once("close", () => controller.abort());
        try {
          await proxyMedia(req, res, media, controller.signal);
        } finally {
          activeRequests.delete(controller);
        }
        return;
      }

      res.writeHead(404).end("Not found");
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  return {
    port,
    baseUrl: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const controller of activeRequests) controller.abort();
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
