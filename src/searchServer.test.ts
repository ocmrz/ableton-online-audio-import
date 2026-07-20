import assert from "node:assert/strict";
import { test } from "node:test";

import type { ResolvedMedia } from "./media.js";
import { upstreamHeaders } from "./searchServer.js";

test("upstreamHeaders works without the global Headers constructor", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Headers");
  Object.defineProperty(globalThis, "Headers", {
    configurable: true,
    value: undefined,
    writable: true,
  });

  try {
    const media: ResolvedMedia = {
      url: "https://media.example/audio.mp3",
      ext: "mp3",
      durationS: 10,
      httpHeaders: {
        "User-Agent": "Online Audio Test",
        Host: "untrusted.example",
        Range: "bytes=5-10",
        "X-Test": "kept",
      },
    };
    assert.deepEqual(upstreamHeaders(media, "bytes=0-1023"), {
      "User-Agent": "Online Audio Test",
      "X-Test": "kept",
      "Accept-Encoding": "identity",
      Range: "bytes=0-1023",
    });
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "Headers", descriptor);
    } else {
      delete (globalThis as { Headers?: unknown }).Headers;
    }
  }
});
