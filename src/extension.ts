import {
  initialize,
  AudioTrack,
  ClipSlot,
  type ActivationContext,
  type ArrangementSelection,
  type AudioClip,
  type Handle,
} from "@ableton-extensions/sdk";
import * as fsp from "node:fs/promises";

import {
  DownloadError,
  downloadAudio,
  normalizeTimeRange,
  type DownloadAudioOptions,
} from "./download.js";
import { ensureFfmpeg } from "./ffmpegBootstrap.js";
import { MediaResolver } from "./media.js";
import type { Candidate, MediaSource, TimeRange } from "./types.js";
import { displayName } from "./types.js";
import { applyLiveTheme } from "./theme.js";
import { abletonFontFaceCss } from "./abletonFonts.js";
import { ensureYtDlp } from "./ytdlpBootstrap.js";
import { startSearchServer } from "./searchServer.js";
import importHtml from "./import.html";
import logoYoutube from "../assets/youtube.png";
import logoYoutubeMusic from "../assets/youtube-music.png";
import logoSoundcloud from "../assets/soundcloud.png";

let liveFontCss = "";

function withLogos(html: string): string {
  const out = html
    .replaceAll("__LOGO_YOUTUBE__", logoYoutube)
    .replaceAll("__LOGO_YOUTUBE_MUSIC__", logoYoutubeMusic)
    .replaceAll("__LOGO_SOUNDCLOUD__", logoSoundcloud);
  return out;
}
function requireDir(dir: string | undefined, name: string): string {
  if (!dir) {
    throw new Error(
      `No ${name} directory available. When running via the CLI, pass --${name}-directory.`,
    );
  }
  return dir;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errorHtml(heading: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>${escapeHtml(heading)}</title><style>
/*__LIVE_THEME__*/
html{background:var(--p-live-ui-bg);color:var(--p-live-text-primary);font-family:"AbletonSansSmall",sans-serif;font-size:11px;font-weight:400;height:100%}
body{margin:0;height:100vh;display:flex;flex-direction:column}
.content{flex:1;display:flex;flex-direction:column;gap:.6em;align-items:center;justify-content:center;padding:1.4em;text-align:center}
h1{font-size:1.1em;margin:0;color:var(--p-live-heading)}code{background:var(--p-live-input-bg);padding:.15em .4em;border-radius:3px;color:var(--p-live-accent-primary)}
button{margin-top:.4em;background:#cfcfcf;color:#4f4f4f;border:1px solid #4f4f4f;height:22px;padding:0 1.2em;border-radius:11px;cursor:pointer}
</style><script>
document.title=${JSON.stringify(heading)};
function done(){var m={method:"close_and_send",params:["{}"]};
if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live)window.webkit.messageHandlers.live.postMessage(m);
else if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage(m);}
document.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key==="Escape")done();});
</script></head><body>
<div class="alx-titlebar">${escapeHtml(heading)}</div>
<div class="content"><h1>${escapeHtml(heading)}</h1><div>${body}</div>
<button type="button" onclick="done()">OK</button></div>
</body></html>`;
}

function retryHtml(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>Online Audio</title><style>
/*__LIVE_THEME__*/
html{background:var(--p-live-chrome-bg);color:var(--p-live-text-primary);font-family:"AbletonSansSmall",sans-serif;font-size:11px;font-weight:400;height:100%}
body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--p-live-chrome-bg)}
.dialog{flex:1;min-height:0;display:flex;flex-direction:column;margin:8px;border-radius:8px;overflow:hidden;background:var(--p-live-ui-bg)}
.message{flex:1;display:grid;grid-template-columns:76px minmax(0,1fr);gap:22px;align-items:center;padding:18px 24px 10px}
.warning-icon{display:block;width:72px;height:64px}
.message-text{color:var(--p-live-surface-text);font-size:14px;line-height:1.35;text-align:left}
.footer{display:flex;gap:4px;justify-content:flex-end;align-items:center;padding:0 20px 16px;background:transparent;border-top:0}
.button{-webkit-appearance:none;appearance:none;margin:0;background:var(--p-live-control-bg);color:var(--p-live-control-text--enabled);border:1px solid var(--p-live-control-border);height:14px;padding:0 20px;border-radius:7px;font:inherit;font-size:9px;line-height:12px;cursor:default;box-sizing:border-box}
.button:hover{background:var(--p-live-control-bg);color:var(--p-live-control-text--enabled)}
.button:active{background:var(--p-live-accent-primary);color:#121212}
</style><script>
document.title="Online Audio";
function done(value){var m={method:"close_and_send",params:[value]};
if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live)window.webkit.messageHandlers.live.postMessage(m);
else if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage(m);}
document.addEventListener("keydown",function(e){
if(e.key==="Enter")done("retry");else if(e.key==="Escape")done("cancel");});
</script></head><body>
<div class="alx-titlebar"></div>
<div class="dialog"><div class="message">
<svg class="warning-icon" viewBox="0 0 96 84" aria-hidden="true">
<path fill="#050505" d="M42.2 7.3a6.7 6.7 0 0 1 11.6 0l39.3 68.1A5.7 5.7 0 0 1 88.2 84H7.8a5.7 5.7 0 0 1-4.9-8.6z"/>
<path fill="var(--p-live-ui-bg)" d="M43.5 25h9l-1.8 32h-5.4z"/>
<circle cx="48" cy="68" r="5" fill="var(--p-live-ui-bg)"/>
</svg>
<div class="message-text">${escapeHtml(body)}</div></div>
<div class="footer"><button class="button" type="button" onclick="done('cancel')">Cancel</button>
<button class="button" type="button" onclick="done('retry')">Try Again</button></div></div>
</body></html>`;
}

async function showError(
  context: ReturnType<typeof initialize>,
  html: string,
  width: number,
  height: number,
): Promise<void> {
  // Error dialogs stay data: — no network needed.
  await context.ui.showModalDialog(
    `data:text/html;charset=utf-8,${encodeURIComponent(applyLiveTheme(html, liveFontCss))}`,
    width,
    height,
  );
}

async function showRetry(
  context: ReturnType<typeof initialize>,
  body: string,
): Promise<boolean> {
  const result = await context.ui.showModalDialog(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      applyLiveTheme(retryHtml(body), liveFontCss),
    )}`,
    520,
    240,
  );
  return result === "retry";
}

interface ImportPick {
  candidate: Candidate;
  range: TimeRange | null;
}

function parseImportPick(raw: string): ImportPick | null {
  try {
    const parsed = JSON.parse(raw) as {
      candidate?: unknown;
      range?: unknown;
    };
    const c = parsed.candidate;
    if (!c || typeof c !== "object") return null;
    const o = c as Record<string, unknown>;
    const source = o.source;
    if (source !== "youtube" && source !== "soundcloud") return null;
    if (typeof o.id !== "string" || typeof o.url !== "string") return null;
    if (typeof o.title !== "string") return null;
    const candidate: Candidate = {
      id: o.id,
      url: o.url,
      title: o.title,
      artists: Array.isArray(o.artists)
        ? o.artists.filter((a): a is string => typeof a === "string")
        : [],
      album: typeof o.album === "string" ? o.album : null,
      durationS: typeof o.durationS === "number" ? o.durationS : null,
      source: source as MediaSource,
      channel: typeof o.channel === "string" ? o.channel : null,
      searchRank: typeof o.searchRank === "number" ? o.searchRank : 0,
    };
    const rangeValue = parsed.range;
    if (!rangeValue || typeof rangeValue !== "object") {
      return { candidate, range: null };
    }
    const rangeObject = rangeValue as Record<string, unknown>;
    const startS = rangeObject.startS;
    const endS = rangeObject.endS;
    if (
      typeof startS !== "number" ||
      typeof endS !== "number" ||
      !Number.isFinite(startS) ||
      !Number.isFinite(endS) ||
      startS < 0 ||
      endS <= startS
    ) {
      return null;
    }
    return { candidate, range: { startS, endS } };
  } catch {
    return null;
  }
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  const fontCssPromise = abletonFontFaceCss(
    context.environment.storageDirectory,
  )
    .catch((err) => {
      console.warn("Could not load AbletonSansSmall:", err);
      return "/* AbletonSansSmall not found */";
    })
    .then((css) => {
      liveFontCss = css;
      return css;
    });

  type Placement = (filePath: string) => Promise<AudioClip<"1.0.0">>;

  const run = async (buildPlacement: () => Placement): Promise<void> => {
    if (!liveFontCss) {
      liveFontCss = await fontCssPromise;
    }
    const placement = buildPlacement();
    const storageDir = requireDir(
      context.environment.storageDirectory,
      "storage",
    );
    const tempDir = requireDir(context.environment.tempDirectory, "temp");
    await fsp.mkdir(storageDir, { recursive: true });
    await fsp.mkdir(tempDir, { recursive: true });

    let ytDlpPath = "";
    try {
      await context.ui.withinProgressDialog(
        "Preparing…",
        { progress: 0 },
        async (update, signal) => {
          ytDlpPath = await ensureYtDlp(storageDir, {
            signal,
            onStatus: (message, pct) => {
              void update(message, pct ?? 0);
            },
          });
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "aborted") return;
      await showError(
        context,
        errorHtml(
          "Downloader setup failed",
          "Could not download yt-dlp automatically. Check your network and try again.<br/><br/>" +
            msg.replace(/\n/g, "<br/>"),
        ),
        480,
        240,
      );
      return;
    }

    const mediaResolver = new MediaResolver(ytDlpPath);
    const server = await startSearchServer({
      html: withLogos(applyLiveTheme(importHtml, liveFontCss)),
      ytDlpPath,
      storageDir,
      mediaResolver,
    });

    let pickRaw = "{}";
    try {
      pickRaw = await context.ui.showModalDialog(server.baseUrl + "/", 620, 500);
    } catch (error) {
      mediaResolver.close();
      throw error;
    } finally {
      await server.close().catch(() => {});
    }

    const pick = parseImportPick(pickRaw);
    if (!pick) {
      mediaResolver.close();
      return;
    }
    const chosen = pick.candidate;

    try {
      const selectedRange = normalizeTimeRange(
        pick.range ?? undefined,
        chosen.durationS,
      );
      let ffmpegPath: string | undefined;
      for (;;) {
        try {
          await context.ui.withinProgressDialog(
            "Importing…",
            { progress: 0 },
            async (update, signal) => {
              try {
              const preparationStartPct = selectedRange ? 50 : 5;
              if (selectedRange && !ffmpegPath) {
                await update("Preparing audio trimmer…", 5);
                try {
                  ffmpegPath = await ensureFfmpeg(storageDir, {
                    signal,
                    onStatus: (message, pct) => {
                      void update(
                        message,
                        Math.round(5 + (pct ?? 0) * 0.45),
                      );
                    },
                  });
                } catch (error) {
                  if (signal.aborted) return;
                  const message =
                    error instanceof Error ? error.message : String(error);
                  throw new Error(
                    `Could not download the audio trimmer automatically. Check your network and try again.\n${message}`,
                  );
                }
              }

              await update("Preparing…", preparationStartPct);
              let latestPct = preparationStartPct;
              let latestLabel = "Downloading…";
              let preparationLabel = "Preparing…";
              let progressEvents = 0;
              let downloadDone = false;
              const startedAt = Date.now();
              const downloadOptions: DownloadAudioOptions = {
                mediaResolver,
                onRetry: () => {
                  preparationLabel = "Retrying download…";
                  latestLabel = preparationLabel;
                },
              };
              if (selectedRange && ffmpegPath) {
                downloadOptions.range = selectedRange;
                downloadOptions.ffmpegPath = ffmpegPath;
              }

              const downloadPromise = downloadAudio(
                ytDlpPath,
                chosen,
                tempDir,
                (p) => {
                  progressEvents += 1;
                  // Map yt-dlp 0–100 into download phase 55–85 (prep used 5–55).
                  const uiPct = Math.min(
                    85,
                    Math.max(55, Math.round(55 + p.pct * 0.3)),
                  );
                  if (uiPct > latestPct) latestPct = uiPct;
                  latestLabel = p.speed
                    ? `Downloading… ${p.speed}`
                    : "Downloading…";
                },
                signal,
                downloadOptions,
              ).finally(() => {
                downloadDone = true;
              });

              // yt-dlp is silent for ~10s while resolving, then the file often
              // finishes in <1s — so paint prep progress on this await path.
              while (!downloadDone) {
                const elapsed = Date.now() - startedAt;
                let label: string;
                let pct: number;
                if (progressEvents === 0) {
                  label = preparationLabel;
                  pct = Math.min(
                    55,
                    Math.round(
                      preparationStartPct +
                        (55 - preparationStartPct) *
                          (1 - Math.exp(-elapsed / 10_000)),
                    ),
                  );
                } else {
                  label = latestLabel;
                  pct = latestPct;
                }
                await update(label, pct);
                await Promise.race([
                  downloadPromise.catch(() => undefined),
                  new Promise<void>((r) => setTimeout(r, 150)),
                ]);
              }

              const audioPath = await downloadPromise;
              if (signal.aborted) return;

              await update(latestLabel, Math.max(latestPct, 85));

              await update("Importing into project…", 92);
              const imported =
                await context.resources.importIntoProject(audioPath);
              if (signal.aborted) return;

              await update("Creating clip…", 98);
              const clip = await placement(imported);
              clip.name = displayName(chosen);

              await update("Done", 100);
              } catch (err) {
                if (signal.aborted) return;
                throw err;
              }
            },
          );
          return;
        } catch (err) {
          console.error("[online-audio-import]", err);
          if (err instanceof DownloadError) {
            const retry = await showRetry(
              context,
            "Online Audio could not finish the download after retrying. Would you like to try again?",
            );
            if (retry) continue;
            return;
          }

          const message = err instanceof Error ? err.message : String(err);
          await showError(
            context,
            errorHtml(
              "Import failed",
              escapeHtml(message).replace(/\n/g, "<br/>"),
            ),
            480,
            240,
          );
          return;
        }
      }
    } finally {
      mediaResolver.close();
    }
  };

  context.commands.registerCommand("onlineAudioImport.slot", (arg: unknown) => {
    void run(() => {
      const slot = context.getObjectFromHandle(arg as Handle, ClipSlot);
      return (filePath: string) =>
        slot.createAudioClip({ filePath, isWarped: false });
    }).catch((e: unknown) => console.error("[online-audio-import]", e));
  });

  context.commands.registerCommand("onlineAudioImport.arrSelection", (arg: unknown) => {
    void run(() => {
      const sel = arg as ArrangementSelection;
      const first = sel.selected_lanes[0];
      if (!first) throw new Error("No track in the arrangement selection.");
      const track = context.getObjectFromHandle(first, AudioTrack);
      return (filePath: string) =>
        track.createAudioClip({
          filePath,
          startTime: sel.time_selection_start,
          isWarped: false,
        });
    }).catch((e: unknown) => console.error("[online-audio-import]", e));
  });

  context.commands.registerCommand("onlineAudioImport.track", (arg: unknown) => {
    void run(() => {
      const track = context.getObjectFromHandle(arg as Handle, AudioTrack);
      return (filePath: string) =>
        track.createAudioClip({ filePath, startTime: 0, isWarped: false });
    }).catch((e: unknown) => console.error("[online-audio-import]", e));
  });

  const label = "Import…";
  void context.ui.registerContextMenuAction("ClipSlot", label, "onlineAudioImport.slot");
  void context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    label,
    "onlineAudioImport.arrSelection",
  );
  void context.ui.registerContextMenuAction("AudioTrack", label, "onlineAudioImport.track");
}
