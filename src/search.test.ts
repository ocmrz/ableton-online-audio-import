import assert from "node:assert/strict";
import { test } from "node:test";

import {
  archiveItemKind,
  isExcludedArchiveDoc,
  openverseItemKind,
  parseArchiveRuntime,
  searchArchive,
  searchBbc,
  searchOpenverse,
} from "./search.js";

test("searchBbc maps BBC API results to sound-effect candidates", async () => {
  const originalFetch = globalThis.fetch;
  let requestedBody = "";
  globalThis.fetch = async (_input, init) => {
    requestedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        results: [
          {
            id: "07005210",
            description: "Heavy rain, on turf and trees.",
            duration: 367922.744,
            categories: [{ className: "Nature" }],
            technicalMetadata: { duration: "367.922744" },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const results = await searchBbc("heavy rain");
    assert.equal(JSON.parse(requestedBody).criteria.query, "heavy rain");
    assert.deepEqual(results, [
      {
        id: "07005210",
        url: "https://sound-effects.bbcrewind.co.uk/search?q=07005210",
        title: "Heavy rain, on turf and trees.",
        artists: [],
        album: "Nature",
        durationS: 367.922744,
        source: "bbc",
        channel: "BBC Sound Effects",
        searchRank: 0,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseArchiveRuntime reads common Internet Archive durations", () => {
  assert.equal(parseArchiveRuntime("3:45"), 225);
  assert.equal(parseArchiveRuntime("5:48.18"), 348.18);
  assert.equal(parseArchiveRuntime("1:02:03"), 3723);
  assert.equal(parseArchiveRuntime("90.5"), 90.5);
  assert.equal(parseArchiveRuntime("2:26:32 (CD1 - 74:14)"), 8792);
  assert.equal(parseArchiveRuntime(""), null);
});

test("archiveItemKind splits music from sound effects", () => {
  assert.equal(
    archiveItemKind({
      identifier: "WilliamDyerSoundEffectsLibrary",
      title: "Sound Effects Library",
      collection: ["folksoundomy_effects", "folksoundomy"],
      subject: ["sound effects", "foley"],
    }),
    "sound-effect",
  );
  assert.equal(
    archiveItemKind({
      identifier: "relaxingrainsounds",
      title: "Nature Sounds - Rain Sounds",
      collection: ["opensource_audio", "community"],
      subject: ["nature", "water", "rain", "sounds"],
    }),
    "sound-effect",
  );
  assert.equal(
    archiveItemKind({
      identifier: "AllGratefulDeadGuestSit-ins66To95",
      title: "All Grateful Dead Guest Sit-Ins '66 to '95",
      collection: ["roiocollection", "folksoundomy"],
      subject: ["live", "guest sit-ins", "Grateful dead"],
    }),
    "music",
  );
  assert.equal(
    archiveItemKind({
      identifier: "NS050",
      title: "Another Day, Another Way",
      collection: ["no-source", "netlabels"],
      subject: ["acoustic", "electronic", "compilation"],
    }),
    "music",
  );
  assert.equal(
    archiveItemKind({
      identifier: "bollywood-hits-2020",
      title: "Bollywood Hits 2020",
      collection: ["opensource_audio"],
      subject: ["Bollywood", "Hindi"],
    }),
    "music",
  );
  assert.equal(
    archiveItemKind({
      identifier: "some-indian-raga",
      title: "Raga Yaman",
      collection: ["opensource_audio", "community"],
      subject: ["Indian Classical", "Hindustani"],
    }),
    "music",
  );
});

test("isExcludedArchiveDoc drops spoken-word Archive catalogs", () => {
  assert.equal(
    isExcludedArchiveDoc({
      identifier: "prince_pa_librivox",
      collection: ["librivoxaudio"],
      subject: ["audiobook"],
    }),
    true,
  );
  assert.equal(
    isExcludedArchiveDoc({
      identifier: "OTRR_Ranger_Bill_Singles",
      collection: ["oldtimeradio"],
      subject: ["Old Time Radio"],
    }),
    true,
  );
  assert.equal(
    isExcludedArchiveDoc({
      identifier: "some-podcast-ep",
      collection: ["podcasts_miscellaneous"],
      subject: ["podcast"],
    }),
    true,
  );
  assert.equal(
    isExcludedArchiveDoc({
      identifier: "Quran-MP3-Ghamdi",
      title: "Quran Recitation by Saad Al-Ghamdi",
      collection: ["audio_islamic", "audio_religion"],
    }),
    true,
  );
  assert.equal(
    isExcludedArchiveDoc({
      identifier: "MuftiMenk",
      title: "Mufti Menk",
      collection: ["opensource_audio"],
      subject: ["mufti", "menk", "lecture", "audio"],
    }),
    true,
  );
  assert.equal(
    isExcludedArchiveDoc({
      identifier: "ptc1978-11-18.flac16",
      title: "The Jonestown Death Tape",
      subject: ["Spoken Word", "Historical"],
    }),
    true,
  );
  assert.equal(
    isExcludedArchiveDoc({
      identifier: "WOLArchive",
      title: "Wrestling Observer Live Archive",
      collection: ["newsletters_inbox", "newsletters", "magazine_rack"],
    }),
    true,
  );
  assert.equal(
    isExcludedArchiveDoc({
      identifier: "KmartOctober1989",
      collection: ["attentionkmartshoppers"],
    }),
    true,
  );
  assert.equal(
    isExcludedArchiveDoc({
      identifier: "the-cute-guy-next-door",
      collection: ["folksoundomy_podfic", "folksoundomy"],
    }),
    true,
  );
  assert.equal(
    isExcludedArchiveDoc({
      identifier: "Insight-160503",
      collection: ["KXJZinsight", "audio_news"],
    }),
    true,
  );
  assert.equal(
    isExcludedArchiveDoc({
      identifier: "some-berkeley-class",
      collection: ["ucberkeley-webcast"],
    }),
    true,
  );
  assert.equal(
    isExcludedArchiveDoc({
      identifier: "mthunder_nlight_rain",
      title: "mthunder_nsounds",
      collection: ["opensource_audio", "community"],
      subject: ["Sound Recordings"],
    }),
    false,
  );
});

test("searchArchive maps Advanced Search results to music candidates", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    assert.match(String(headers?.["User-Agent"] ?? ""), /Online-Audio/);
    return new Response(
      JSON.stringify({
        response: {
          docs: [
            {
              identifier: "OTRR_Ranger_Bill_Singles",
              title: "Ranger Bill - Single Episodes",
              collection: ["oldtimeradio"],
              subject: ["Old Time Radio"],
            },
            {
              identifier: "cjbeards-fire-and-thunder",
              title: "Cjbeards Fire And Thunder",
              creator: "Cjbeards",
              runtime: "4:22",
              collection: ["opensource_audio"],
            },
          ],
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const results = await searchArchive("fire thunder");
    assert.match(requestedUrl, /advancedsearch\.php/);
    assert.match(requestedUrl, /mediatype%3Aaudio/);
    assert.match(requestedUrl, /NOT\+collection|NOT%20collection/);
    assert.match(requestedUrl, /fl\[\]=identifier,title,creator,runtime,collection,subject/);
    assert.deepEqual(results, [
      {
        id: "cjbeards-fire-and-thunder",
        url: "https://archive.org/details/cjbeards-fire-and-thunder",
        title: "Cjbeards Fire And Thunder",
        artists: ["Cjbeards"],
        album: null,
        durationS: 262,
        source: "archive",
        channel: "Internet Archive",
        searchRank: 0,
        kind: "sound-effect",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("searchArchive applies an Archive-specific sound-effect query", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({
        response: {
          docs: [
            {
              identifier: "rain-song",
              title: "Rain Song",
              runtime: "3:00",
              collection: ["audio_music"],
              subject: ["music"],
            },
            {
              identifier: "forest-rain",
              title: "Forest Rain Field Recording",
              runtime: "1:30",
              collection: ["folksoundomy_effects"],
              subject: ["field recording", "nature sounds"],
            },
          ],
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const results = await searchArchive("rain", { kind: "sound-effect" });
    const request = new URL(requestedUrl);
    const archiveQuery = request.searchParams.get("q") ?? "";
    assert.match(archiveQuery, /collection:\(folksoundomy_effects\)/);
    assert.match(archiveQuery, /field recording/);
    assert.equal(request.searchParams.get("rows"), "40");
    assert.deepEqual(results, [
      {
        id: "forest-rain",
        url: "https://archive.org/details/forest-rain",
        title: "Forest Rain Field Recording",
        artists: [],
        album: null,
        durationS: 90,
        source: "archive",
        channel: "Internet Archive",
        searchRank: 0,
        kind: "sound-effect",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("searchArchive fills missing runtime from item file lengths", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("advancedsearch.php")) {
      return new Response(
        JSON.stringify({
          response: {
            docs: [
              {
                identifier: "thunder-pack",
                title: "Thunder Pack",
                creator: "Field Recordist",
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    assert.match(url, /\/metadata\/thunder-pack$/);
    return new Response(
      JSON.stringify({
        files: [
          {
            name: "thunder.mp3",
            format: "VBR MP3",
            length: "12.5",
            size: "200000",
            source: "original",
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const results = await searchArchive("thunder");
    assert.equal(results[0]?.durationS, 12.5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openverseItemKind maps providers to music or sound-effect", () => {
  assert.equal(openverseItemKind("freesound", null), "sound-effect");
  assert.equal(openverseItemKind("jamendo", null), "music");
  assert.equal(openverseItemKind("wikimedia_audio", "music"), "music");
  assert.equal(
    openverseItemKind("wikimedia_audio", "sound effect"),
    "sound-effect",
  );
});

test("searchOpenverse maps API results and requests provider filter", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({
        results: [
          {
            id: "6b072076-066b-45b6-9695-367a6260c96d",
            title: "Rain, Moderate, C.wav",
            foreign_landing_url:
              "https://freesound.org/people/InspectorJ/sounds/401275",
            creator: "InspectorJ",
            provider: "freesound",
            source: "freesound",
            category: null,
            duration: 60116,
            mature: false,
          },
          {
            id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            title: "Hidden mature",
            foreign_landing_url: "https://freesound.org/people/x/sounds/1",
            creator: "x",
            source: "freesound",
            duration: 1000,
            mature: true,
          },
          {
            id: "11111111-2222-3333-4444-555555555555",
            title: "Open piano",
            foreign_landing_url: "https://www.jamendo.com/track/123",
            creator: "Jam Artist",
            source: "jamendo",
            duration: 180000,
            mature: false,
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const results = await searchOpenverse("rain");
    assert.match(requestedUrl, /api\.openverse\.org\/v1\/audio\//);
    assert.match(requestedUrl, /source=freesound%2Cjamendo%2Cwikimedia_audio/);
    assert.deepEqual(results, [
      {
        id: "6b072076-066b-45b6-9695-367a6260c96d",
        url: "https://freesound.org/people/InspectorJ/sounds/401275",
        title: "Rain, Moderate, C.wav",
        artists: ["InspectorJ"],
        album: "Freesound",
        durationS: 60.116,
        source: "openverse",
        channel: "Freesound",
        searchRank: 0,
        kind: "sound-effect",
        provider: "freesound",
      },
      {
        id: "11111111-2222-3333-4444-555555555555",
        url: "https://www.jamendo.com/track/123",
        title: "Open piano",
        artists: ["Jam Artist"],
        album: "Jamendo",
        durationS: 180,
        source: "openverse",
        channel: "Jamendo",
        searchRank: 1,
        kind: "music",
        provider: "jamendo",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
