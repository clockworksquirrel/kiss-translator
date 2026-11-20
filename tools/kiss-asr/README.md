# kiss-asr: local speech-to-text for live subtitles

The extension's live subtitles (videos with no captions) send audio to this
bridge on `127.0.0.1:8177`, which forwards it to whisper.cpp's `whisper-server`
on `127.0.0.1:8178` (model `ggml-large-v3-turbo.bin`, Metal). Non-English text
is translated to English by the extension's normal subtitle translator.

Setup on macOS (Apple Silicon):

    brew install whisper-cpp ffmpeg
    mkdir -p ~/.local/share/whisper-models ~/.local/share/kiss-asr ~/Library/Logs/kiss-asr
    curl -L -o ~/.local/share/whisper-models/ggml-large-v3-turbo.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
    cp kiss-asr-server.py ~/.local/share/kiss-asr/
    # LaunchAgents: see com.josh.whisper-server.plist / com.josh.kiss-asr.plist
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.josh.whisper-server.plist
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.josh.kiss-asr.plist
    curl -s 127.0.0.1:8177/health

Requests need the header `X-Kiss-Asr: 1`; web pages cannot send it (no CORS
preflight is answered), so only the extension's background worker can use it.
