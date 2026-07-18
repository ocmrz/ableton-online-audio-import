# Online Audio for Ableton Live

**Find and import online audio without leaving Ableton Live.**

Online Audio searches YouTube, YouTube Music, and SoundCloud inside Ableton Live. Review the title, artist, source, and duration, then import your pick directly into a clip slot or Arrangement track.

<p align="center">
  <a href="../../releases/latest/download/Online-Audio.ablx"><strong>Download extension (.ablx)</strong></a>
</p>

> Requires **Ableton Live 12.4.5 public beta** with Extensions.

<p align="center">
  <img src="docs/images/online-audio-search.jpg" alt="Online Audio search results in Ableton Live" width="100%">
</p>

## How to use

<p align="center">
  <img src="docs/images/online-audio-menu.png" alt="Ableton Live context menu showing Extensions and Online Audio: Import" width="640">
</p>

1. Right-click a clip slot, an Arrangement selection, or an audio track.
2. Choose **Extensions → Online Audio: Import…**
3. Search for a song or paste a YouTube, YouTube Music, or SoundCloud URL.
4. Pick a result, then select **Import** or press <kbd>Return</kbd>. Online Audio places it in your set.

## Install

1. [Download the extension](../../releases/latest/download/Online-Audio.ablx).
2. Open Live's **Settings**.
3. Select the **Extensions** tab.
4. Drag `Online-Audio.ablx` into the **Drag and drop to install** area.
5. Turn off **Developer Mode** if it is enabled.
6. Quit and reopen Live.

Packaged extensions do not appear while Developer Mode is active.

## Requirements

- Ableton Live 12.4.5 public beta with Extensions

On the first import, Online Audio downloads a managed `yt-dlp` binary into Live's extension storage (about 35 MB). It checks for updates about once a day.

## Use audio responsibly

Download only audio you have permission to use. Follow copyright law and each source's terms of service.

<details>
<summary><strong>Development and packaging</strong></summary>

### Set up

Get the Ableton Extensions SDK tarballs described in [`vendor/README.md`](vendor/README.md), then run:

```bash
npm install
cp .env.example .env
# Set EXTENSION_HOST_PATH in .env to your Live Beta application.
# In Live, enable Preferences → Extensions → Developer Mode.
npm start
```

The SDK tarballs are proprietary and must not be redistributed.

### Build a package

```bash
npm run package
```

The package command produces a versioned `Online-Audio-<version>.ablx` file.

### Publish a download

Attach the build to a GitHub Release with the asset name `Online-Audio.ablx`. The download links at the top of this README always target that file in the latest release.

</details>

## Open source

The source code is available under the [MIT License](LICENSE).
