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

test("global type filters are replaced by Internet Archive refinements", async () => {
  const html = await fsp.readFile(
    new URL("./import.html", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(html, /id="types"/);
  assert.doesNotMatch(html, /data-filter="(?:music|sound-effect)"/);
  assert.match(html, /data-filter="archive-music"/);
  assert.match(html, /data-filter="archive-sound-effect"/);
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

test("Internet Archive refinements stay scoped to Archive results", async () => {
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
            type: "music",
            candidate: { id: "track", source: "youtube" },
          },
          {
            brand: "archive",
            type: "music",
            candidate: {
              id: "concert",
              source: "archive",
              kind: "music",
            },
          },
          {
            brand: "archive",
            type: "sound-effect",
            candidate: {
              id: "field",
              source: "archive",
              kind: "sound-effect",
            },
          },
          {
            brand: "bbc",
            type: "sound-effect",
            candidate: { id: "effect", source: "bbc" },
          },
        ];
        var defaultIds = filtered().map(function (item) {
          return item.candidate.id;
        });
        filters["archive-sound-effect"] = true;
        var archiveSoundEffects = filtered().map(function (item) {
          return item.candidate.id;
        });
        filters["archive-sound-effect"] = false;
        filters["archive-music"] = true;
        var archiveMusic = filtered().map(function (item) {
          return item.candidate.id;
        });
        filters["archive-music"] = false;
        filters.archive = true;
        var archiveOnly = filtered().map(function (item) {
          return item.candidate.id;
        });
        return {
          defaultIds: defaultIds,
          archiveSoundEffects: archiveSoundEffects,
          archiveMusic: archiveMusic,
          archiveOnly: archiveOnly,
        };
      })()
    `,
    context,
  ) as {
    defaultIds: string[];
    archiveSoundEffects: string[];
    archiveMusic: string[];
    archiveOnly: string[];
  };

  // Archive is hidden until its source chip is selected.
  assert.deepEqual(Array.from(result.defaultIds), ["track", "effect"]);
  assert.deepEqual(Array.from(result.archiveSoundEffects), ["field"]);
  assert.deepEqual(Array.from(result.archiveMusic), ["concert"]);
  assert.deepEqual(Array.from(result.archiveOnly), ["concert", "field"]);
});

function sourceFilterContext(script: string) {
  const elements = new Map<string, Record<string, unknown>>();
  const makeEl = (id: string) => {
    const el: Record<string, unknown> = {
      id,
      hidden: id === "archiveSubs" || id === "openverseSubs",
      classList: {
        _values: new Set<string>(),
        toggle(name: string, force?: boolean) {
          const values = el.classList as {
            _values: Set<string>;
            toggle: (name: string, force?: boolean) => boolean;
          };
          if (force === true) values._values.add(name);
          else if (force === false) values._values.delete(name);
          else if (values._values.has(name)) values._values.delete(name);
          else values._values.add(name);
          return values._values.has(name);
        },
      },
      setAttribute() {},
      title: "",
    };
    elements.set(id, el);
    return el;
  };
  makeEl("archiveNest");
  makeEl("archiveWrap");
  makeEl("archiveSubs");
  makeEl("archiveChevron");
  makeEl("openverseNest");
  makeEl("openverseWrap");
  makeEl("openverseSubs");
  makeEl("openverseChevron");

  const context = vm.createContext({
    document: {
      title: "",
      addEventListener() {},
      getElementById(id: string) {
        return elements.get(id) ?? null;
      },
      querySelectorAll() {
        return [];
      },
    },
    window: {},
  });
  new vm.Script(script, { filename: "import.html" }).runInContext(context);
  // Avoid full DOM rendering when exercising filter toggles in isolation.
  vm.runInContext(
    `
      render = function () {
        visible = filtered();
        if (selected >= visible.length) {
          selected = Math.max(0, visible.length - 1);
        }
      };
    `,
    context,
  );
  return { context, elements };
}

test("Openverse results stay hidden until the source nest is opted in", async () => {
  const script = await readInlineScript();
  const { context } = sourceFilterContext(script);

  const result = vm.runInContext(
    `
      (() => {
        ranked = [
          {
            brand: "youtube",
            type: "music",
            candidate: { id: "track", source: "youtube" },
          },
          {
            brand: "openverse",
            type: "sound-effect",
            provider: "freesound",
            candidate: {
              id: "rain",
              source: "openverse",
              provider: "freesound",
              kind: "sound-effect",
            },
          },
          {
            brand: "openverse",
            type: "music",
            provider: "jamendo",
            candidate: {
              id: "piano",
              source: "openverse",
              provider: "jamendo",
              kind: "music",
            },
          },
        ];
        var defaults = filtered().map(function (item) {
          return item.candidate.id;
        });
        toggleFilter("openverse");
        var allOpenverse = filtered().map(function (item) {
          return item.candidate.id;
        });
        toggleFilter("openverse-freesound");
        var freesoundOnly = filtered().map(function (item) {
          return item.candidate.id;
        });
        return {
          defaults: defaults,
          allOpenverse: allOpenverse,
          freesoundOnly: freesoundOnly,
          parentAfterSub: filters.openverse,
          freesound: filters["openverse-freesound"],
          jamendo: filters["openverse-jamendo"],
        };
      })()
    `,
    context,
  ) as {
    defaults: string[];
    allOpenverse: string[];
    freesoundOnly: string[];
    parentAfterSub: boolean;
    freesound: boolean;
    jamendo: boolean;
  };

  assert.deepEqual(Array.from(result.defaults), ["track"]);
  assert.deepEqual(Array.from(result.allOpenverse), ["rain", "piano"]);
  assert.deepEqual(Array.from(result.freesoundOnly), ["rain"]);
  assert.equal(result.parentAfterSub, false);
  assert.equal(result.freesound, true);
  assert.equal(result.jamendo, false);
});

test("source filters are single-select like Ableton categories", async () => {
  const script = await readInlineScript();
  const { context } = sourceFilterContext(script);

  const result = vm.runInContext(
    `
      (() => {
        toggleFilter("openverse-freesound");
        toggleFilter("youtube");
        return {
          youtube: filters.youtube,
          openverse: filters.openverse,
          freesound: filters["openverse-freesound"],
          expanded: openverseExpanded,
        };
      })()
    `,
    context,
  ) as {
    youtube: boolean;
    openverse: boolean;
    freesound: boolean;
    expanded: boolean;
  };

  assert.equal(result.youtube, true);
  assert.equal(result.openverse, false);
  assert.equal(result.freesound, false);
  assert.equal(result.expanded, false);
});

test("Internet Archive refinements are single-select", async () => {
  const script = await readInlineScript();
  const { context } = sourceFilterContext(script);

  const result = vm.runInContext(
    `
      (() => {
        toggleFilter("archive-music");
        toggleFilter("archive-sound-effect");
        return {
          archive: filters.archive,
          music: filters["archive-music"],
          soundEffect: filters["archive-sound-effect"],
          expanded: archiveExpanded,
        };
      })()
    `,
    context,
  ) as {
    archive: boolean;
    music: boolean;
    soundEffect: boolean;
    expanded: boolean;
  };

  assert.equal(result.archive, false);
  assert.equal(result.music, false);
  assert.equal(result.soundEffect, true);
  assert.equal(result.expanded, true);
});

test("Internet Archive chevron selects the category when expanding", async () => {
  const script = await readInlineScript();
  const { context, elements } = sourceFilterContext(script);

  const result = vm.runInContext(
    `
      (() => {
        toggleArchiveExpand();
        return {
          expanded: archiveExpanded,
          archive: filters.archive,
          hidden: document.getElementById("archiveSubs").hidden,
        };
      })()
    `,
    context,
  ) as { expanded: boolean; archive: boolean; hidden: boolean };

  assert.equal(result.expanded, true);
  assert.equal(result.archive, true);
  assert.equal(result.hidden, false);
  assert.equal(
    (
      elements.get("archiveNest")?.classList as { _values: Set<string> }
    )._values.has("expanded"),
    true,
  );
});

test("Openverse chevron selects the category when expanding", async () => {
  const script = await readInlineScript();
  const { context, elements } = sourceFilterContext(script);

  const result = vm.runInContext(
    `
      (() => {
        toggleOpenverseExpand();
        return {
          expanded: openverseExpanded,
          openverse: filters.openverse,
          hidden: document.getElementById("openverseSubs").hidden,
        };
      })()
    `,
    context,
  ) as { expanded: boolean; openverse: boolean; hidden: boolean };

  assert.equal(result.expanded, true);
  assert.equal(result.openverse, true);
  assert.equal(result.hidden, false);
  assert.equal(
    (
      elements.get("openverseNest")?.classList as { _values: Set<string> }
    )._values.has("expanded"),
    true,
  );
});
