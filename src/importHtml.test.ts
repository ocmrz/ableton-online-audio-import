import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

async function readInlineScript(): Promise<string> {
  const html = await fsp.readFile(new URL("./import.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  return script;
}

test("import dialog inline script is valid JavaScript", async () => {
  const script = await readInlineScript();
  assert.doesNotThrow(() => new vm.Script(script, { filename: "import.html" }));
});

test("Shift+Space resumes from a paused seek after playback ends", async () => {
  const script = await readInlineScript();
  const context = vm.createContext({
    document: {
      title: "",
      addEventListener() {},
    },
    window: {},
  });
  new vm.Script(script, { filename: "import.html" }).runInContext(context);

  vm.runInContext(
    `
      previewDuration = 60;
      previewStart = 0;
      previewEnd = 60;
      previewReady = true;
      previewProvider = "youtube";
      providerPaused = true;
      providerCurrentTime = 60;
      stoppedAtRangeEnd = true;
      lastStoppedPreviewTime = 60;
      var playedAt = null;
      youtubePlayer = {
        currentTime: 0,
        getCurrentTime: function () {
          return this.currentTime;
        },
        seekTo: function (time) {
          this.currentTime = time;
        },
        playVideo: function () {
          playedAt = this.currentTime;
        },
      };
      updatePlaybackUi = function () {};

      seekPreview(currentPreviewTime() + 5);
      togglePreview(true);
    `,
    context,
  );

  const result = vm.runInContext(
    "({ lastStoppedPreviewTime, playedAt })",
    context,
  ) as { lastStoppedPreviewTime: number; playedAt: number };
  assert.equal(result.lastStoppedPreviewTime, 5);
  assert.equal(result.playedAt, 5);
});

test("age-restricted YouTube previews become actionable warnings", async () => {
  const script = await readInlineScript();
  const context = vm.createContext({
    document: {
      title: "",
      addEventListener() {},
    },
    window: {},
  });
  new vm.Script(script, { filename: "import.html" }).runInContext(context);

  const result = vm.runInContext(
    `
      (() => {
        var item = { candidate: { source: "youtube" } };
        var classified = applyPreviewError(
          item,
          new Error("Sign in to confirm your age"),
        );
        return {
          classified: classified,
          warning: item.previewWarning,
          message: previewError,
        };
      })()
    `,
    context,
  ) as { classified: boolean; warning: string; message: string };

  assert.equal(result.classified, true);
  assert.equal(result.warning, "age-restricted");
  assert.equal(
    result.message,
    "This audio is age-restricted. Please choose another result.",
  );
});

test("source and type filters are combined by intersection", async () => {
  const script = await readInlineScript();
  const context = vm.createContext({
    document: {
      title: "",
      addEventListener() {},
    },
    window: {},
  });
  new vm.Script(script, { filename: "import.html" }).runInContext(context);

  const result = vm.runInContext(
    `
      (() => {
        ranked = [
          {
            brand: "youtube",
            type: "song",
            candidate: { id: "song", source: "youtube" },
          },
          {
            brand: "bbc",
            type: "sound-effect",
            candidate: { id: "effect", source: "bbc" },
          },
        ];
        filters["sound-effect"] = true;
        var soundEffects = filtered().map(function (item) {
          return item.candidate.id;
        });
        filters.youtube = true;
        var youtubeSoundEffects = filtered().map(function (item) {
          return item.candidate.id;
        });
        return { soundEffects: soundEffects, youtubeSoundEffects: youtubeSoundEffects };
      })()
    `,
    context,
  ) as { soundEffects: string[]; youtubeSoundEffects: string[] };

  assert.deepEqual(Array.from(result.soundEffects), ["effect"]);
  assert.deepEqual(Array.from(result.youtubeSoundEffects), []);
});
