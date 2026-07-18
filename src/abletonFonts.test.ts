import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { abletonFontDirectoryCandidates } from "./abletonFonts.js";

describe("abletonFontDirectoryCandidates", () => {
  it("derives the macOS font directory from the Extension Host executable", () => {
    const candidates = abletonFontDirectoryCandidates(
      "darwin",
      {},
      "/Custom/Ableton Live 12 Suite.app/Contents/Helpers/ExtensionHost/node",
    );

    assert.equal(
      candidates[0],
      "/Custom/Ableton Live 12 Suite.app/Contents/App-Resources/Fonts",
    );
  });

  it("derives a future Windows Live path from the Extension Host", () => {
    const candidates = abletonFontDirectoryCandidates(
      "win32",
      {},
      "E:\\Audio\\Ableton\\Live 13 Suite\\Resources\\Extensions\\ExtensionHost\\node.exe",
    );

    assert.equal(
      candidates[0],
      "E:\\Audio\\Ableton\\Live 13 Suite\\Resources\\Fonts",
    );
  });

  it("returns no candidates on unsupported systems", () => {
    assert.deepEqual(
      abletonFontDirectoryCandidates("linux", {}, "/usr/bin/node"),
      [],
    );
  });
});
