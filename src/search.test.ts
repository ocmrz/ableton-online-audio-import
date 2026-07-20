import assert from "node:assert/strict";
import { test } from "node:test";

import { searchBbc } from "./search.js";

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
