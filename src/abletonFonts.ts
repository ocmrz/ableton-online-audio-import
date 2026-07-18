import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { runProcess } from "./process.js";

const FONT_FILES = [
  "AbletonSansSmall-Regular.ttf",
  "AbletonSansSmall-Bold.ttf",
] as const;

function pathAndAncestors(
  value: string,
  pathApi: typeof path.posix,
): string[] {
  const result: string[] = [];
  let current = value;

  while (current && !result.includes(current)) {
    result.push(current);
    const parent = pathApi.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function abletonFontDirectoryCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  executablePath: string = process.execPath,
): string[] {
  if (platform === "darwin") {
    const envRoots = env.EXTENSION_HOST_PATH
      ? pathAndAncestors(env.EXTENSION_HOST_PATH, path.posix)
      : [];
    const executableRoots = pathAndAncestors(executablePath, path.posix);
    const appRoots = [...envRoots, ...executableRoots].filter((root) =>
      root.endsWith(".app"),
    );

    return unique(appRoots).map((root) =>
      path.posix.join(root, "Contents", "App-Resources", "Fonts"),
    );
  }

  if (platform === "win32") {
    const envRoots = env.EXTENSION_HOST_PATH
      ? pathAndAncestors(env.EXTENSION_HOST_PATH, path.win32)
      : [];
    const executableRoots = pathAndAncestors(executablePath, path.win32);
    const discoveredRoots = [...envRoots, ...executableRoots];
    const likelyLiveRoots = discoveredRoots.filter((root) =>
      /^(?:Ableton )?Live(?: |$)/i.test(path.win32.basename(root)),
    );

    return unique([...likelyLiveRoots, ...discoveredRoots]).map((root) =>
      path.win32.join(root, "Resources", "Fonts"),
    );
  }

  return [];
}

async function containsFonts(dir: string): Promise<boolean> {
  try {
    await Promise.all(FONT_FILES.map((file) => fsp.access(path.join(dir, file))));
    return true;
  } catch {
    return false;
  }
}

async function copyFontFiles(
  sourceDir: string,
  targetDir: string,
): Promise<boolean> {
  if (process.platform === "darwin") {
    const result = await runProcess("/bin/cp", [
      ...FONT_FILES.map((file) => path.join(sourceDir, file)),
      targetDir,
    ]).catch(() => null);
    return result?.code === 0;
  }

  if (process.platform === "win32") {
    const windowsDir =
      process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const robocopy = path.win32.join(windowsDir, "System32", "Robocopy.exe");
    const result = await runProcess(robocopy, [
      sourceDir,
      targetDir,
      ...FONT_FILES,
      "/R:0",
      "/W:0",
      "/NFL",
      "/NDL",
      "/NJH",
      "/NJS",
      "/NP",
    ]).catch(() => null);

    // Robocopy uses 0–7 for successful outcomes and 8+ for failures.
    return result?.code !== null && result?.code !== undefined && result.code < 8;
  }

  return false;
}

async function copyFontsToStorage(storageDir: string): Promise<string | null> {
  const targetDir = path.join(storageDir, "fonts");
  await fsp.mkdir(targetDir, { recursive: true });
  if (await containsFonts(targetDir)) return targetDir;

  const sourceDirs = abletonFontDirectoryCandidates();
  if (sourceDirs.length === 0) return null;

  for (const sourceDir of sourceDirs) {
    if (
      (await copyFontFiles(sourceDir, targetDir)) &&
      (await containsFonts(targetDir))
    ) {
      return targetDir;
    }

    await Promise.all(
      FONT_FILES.map((file) => fsp.rm(path.join(targetDir, file), { force: true })),
    );
  }

  return null;
}

async function findFontsDir(storageDir?: string): Promise<string | null> {
  if (storageDir) {
    const copied = await copyFontsToStorage(storageDir);
    if (copied) return copied;
  }

  // Developer Mode does not apply Live's packaged-extension filesystem limits.
  for (const dir of abletonFontDirectoryCandidates()) {
    if (await containsFonts(dir)) return dir;
  }

  return null;
}

/**
 * Embed AbletonSansSmall from the Live app bundle so the WebView actually
 * renders it. Packaged extensions first copy the user's local font files into
 * their permitted storage directory through the platform's copy utility.
 */
export async function abletonFontFaceCss(storageDir?: string): Promise<string> {
  const dir = await findFontsDir(storageDir);
  if (!dir) return "/* AbletonSansSmall not found */";

  const regular = await fsp.readFile(path.join(dir, FONT_FILES[0]));
  const bold = await fsp.readFile(path.join(dir, FONT_FILES[1]));

  return `
@font-face {
  font-family: "AbletonSansSmall";
  src: url(data:font/ttf;base64,${regular.toString("base64")}) format("truetype");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "AbletonSansSmall";
  src: url(data:font/ttf;base64,${bold.toString("base64")}) format("truetype");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
`.trim();
}
