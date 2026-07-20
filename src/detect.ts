import { URL } from "node:url";

import type { MediaSource } from "./types.js";

export type DetectedInput =
  | { kind: "url"; source: MediaSource; url: string }
  | { kind: "query"; query: string };

const YT_HOST =
  /(?:^|\.)(?:youtube\.com|youtu\.be|music\.youtube\.com)$/i;
const SC_HOST = /(?:^|\.)(?:soundcloud\.com|on\.soundcloud\.com)$/i;
const ARCHIVE_HOST = /(?:^|\.)archive\.org$/i;

function tryParseUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed);
    if (
      /^(www\.|m\.|music\.)?(youtube\.com|youtu\.be|soundcloud\.com|archive\.org)\//i.test(
        trimmed,
      )
    ) {
      return new URL(`https://${trimmed}`);
    }
  } catch {
    return null;
  }
  return null;
}

/** Extract an item id from archive.org /details/ or /download/ URLs. */
export function archiveIdFromUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "archive.org") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] !== "details" && parts[0] !== "download") return null;
  const id = parts[1] ?? "";
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/.test(id) ? id : null;
}

export function detectInput(raw: string): DetectedInput {
  const trimmed = raw.trim();
  const url = tryParseUrl(trimmed);
  if (url) {
    const host = url.hostname.replace(/^www\./i, "");
    if (YT_HOST.test(host) || host === "youtu.be") {
      return { kind: "url", source: "youtube", url: url.toString() };
    }
    if (SC_HOST.test(host)) {
      return { kind: "url", source: "soundcloud", url: url.toString() };
    }
    if (ARCHIVE_HOST.test(host) && archiveIdFromUrl(url.toString())) {
      return { kind: "url", source: "archive", url: url.toString() };
    }
  }
  return { kind: "query", query: trimmed };
}
