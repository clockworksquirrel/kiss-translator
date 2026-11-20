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
  stable: `mfmfjppohbnanfaekhhiofahakglmngj`.

## Build
The API key is never committed. Put it in the untracked `.env.local`:

    REACT_APP_PINCHPOINT_KEY=...

Then `pnpm install --no-frozen-lockfile && pnpm build:chrome`. Output: `build/chrome`.
