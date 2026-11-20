# Josh's fork of KISS Translator

Upstream: https://github.com/fishjar/kiss-translator

## What changed
- Default target language is English everywhere (page, selection, input box, subtitles, files, images).
- English only: page translation replaces the original text (`transOnly: "true"`), subtitles are not bilingual, hover translation uses the bubble.
- Page translation is on by default on every site (`transOpen: "true"`). Text already in English is skipped by language detection.
- Default translator: "PinchPoint Local (Qwen3-30B-A3B)", an OpenAI-compatible service at
  `https://direct-api.pinchpoint.cloud/local/v1/chat/completions`, model `qwen3-30b-a3b`,
  thinking off via `chat_template_kwargs.enable_thinking=false`. Used for subtitles too.
- New `src/subtitle/GenericVideoSubtitles.js`: English captions on any site with a `<video>`
  (text tracks get an "English (KISS)" track; DOM caption players are translated in place),
  including iframes. www.youtube.com keeps the upstream YouTube provider.
- Upstream update check is off. Manifest has a fixed public key, so the unpacked extension ID is
  stable: `dfchkihicillaemodjnbddhkecfbkpke`.

- Live speech subtitles (`src/subtitle/LiveSpeechSubtitles.js`, setting `subtitleSetting.liveAsr`,
  on by default, switch in Options > Subtitles; command "Live speech subtitles on/off for this tab"
  can be bound in the browser's shortcuts page). A playing, unmuted video with no captions gets
  English subtitles from its own audio:
  - audio: `video.captureStream()` (same-origin, MSE/blob players such as YouTube, CORS media),
    cut at pauses into 1.5 to 6 s chunks; when the browser refuses capture (cross-origin file
    without CORS, e.g. Wikimedia's player) the local bridge pulls that slice of the file with
    ffmpeg ahead of playback, so those subtitles are on time.
  - speech to text: local whisper.cpp `whisper-server` with `ggml-large-v3-turbo` (Metal) behind
    the `tools/kiss-asr` bridge on `127.0.0.1:8177` (LaunchAgents `com.josh.whisper-server`,
    `com.josh.kiss-asr`). PinchPoint has no audio endpoint (checked 2026-11-20: 501 on
    `/audio/transcriptions`).
  - non-English text is translated by the normal subtitle translator (PinchPoint Qwen3);
    English is shown as transcribed. Rendered as the native text track "English (KISS live)".
  - stops on pause (flushes the last chunk), resets on seek, stops if real captions appear.
    On www.youtube.com it runs only when the player says captions are unavailable.
  - measured on the M4 Max: Whisper ~0.75 s per chunk, Qwen ~0.9 s; text appears about 0.8 s
    (English) or 1.7 to 2.3 s (translated) after each spoken chunk ends.

## Build
The API key is never committed. Put it in the untracked `.env.local`:

    REACT_APP_PINCHPOINT_KEY=...

Then `pnpm install --no-frozen-lockfile && pnpm build:chrome`. Output: `build/chrome`.
