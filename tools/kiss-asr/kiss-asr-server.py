#!/usr/bin/env python3
"""KISS Translator (Josh fork) local speech-to-text bridge.

Listens on 127.0.0.1:8177 and sits in front of whisper.cpp's whisper-server
(127.0.0.1:8178). Two endpoints, both POST, both require header X-Kiss-Asr: 1
(browsers cannot send that cross-site without a CORS preflight, which this
server never answers, so web pages cannot use it):

  /v1/asr?translate=0|1&prompt=...      body: 16 kHz mono WAV
  /v1/asr-url  JSON {url, start, duration, translate, referer, prompt}
                ffmpeg pulls that slice of a media URL (http/https only)

Response JSON: {text, language, segments:[{start,end,text}], ms}
No secrets, no logging of audio or text.
"""
import json, os, subprocess, sys, time, urllib.request, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

WHISPER = os.environ.get("KISS_WHISPER_URL", "http://127.0.0.1:8178/inference")
FFMPEG = "/opt/homebrew/bin/ffmpeg"
PORT = int(os.environ.get("KISS_ASR_PORT", "8177"))

# Common Whisper hallucinations on music/silence.
JUNK = (
    "thank you for watching", "thanks for watching", "subtitles by",
    "please subscribe", "like and subscribe", "amara.org", "transcribed by",
    "sous-titrage", "untertitel im auftrag", "subtítulos realizados",
)


def clean(text):
    t = " ".join((text or "").split())
    low = t.lower().strip(" .!")
    if not low or low in ("you", "bye", "[music]", "(music)", "[blank_audio]"):
        return ""
    if any(j in low for j in JUNK) and len(low) < 80:
        return ""
    if t.startswith("[") and t.endswith("]"):
        return ""
    return t


def whisper(wav, translate=False, prompt=""):
    boundary = uuid.uuid4().hex
    fields = {
        "response_format": "verbose_json",
        "temperature": "0.0",
        "temperature_inc": "0.2",
        "language": "auto",
        "translate": "true" if translate else "false",
        "no_timestamps": "false",
    }
    if prompt:
        fields["prompt"] = prompt[-200:]
    parts = []
    for k, v in fields.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        )
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\n"
        "Content-Type: audio/wav\r\n\r\n".encode() + wav + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        WHISPER,
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read().decode("utf-8", "replace"))
    segs = []
    for s in d.get("segments") or []:
        txt = clean(s.get("text"))
        if not txt:
            continue
        if float(s.get("no_speech_prob") or 0) > 0.8:
            continue
        segs.append({"start": float(s.get("start") or 0), "end": float(s.get("end") or 0), "text": txt})
    return {
        "text": " ".join(s["text"] for s in segs),
        "language": d.get("language") or "",
        "segments": segs,
    }


def slice_url(url, start, duration, referer=""):
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        raise ValueError("bad scheme")
    cmd = [FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error",
           "-protocol_whitelist", "http,https,tcp,tls,crypto,hls,applehttp,file",
           "-rw_timeout", "15000000"]
    if referer:
        cmd += ["-headers", f"Referer: {referer}\r\n"]
    cmd += ["-ss", f"{max(0.0, start):.3f}", "-t", f"{min(30.0, max(0.5, duration)):.3f}",
            "-i", url, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "-"]
    out = subprocess.run(cmd, capture_output=True, timeout=45)
    # ffmpeg can exit non-zero at a truncated/unindexed end but still give audio.
    if len(out.stdout) < 16000:
        raise RuntimeError("ffmpeg failed: " + out.stderr.decode("utf-8", "replace")[-300:])
    return out.stdout


class H(BaseHTTPRequestHandler):
    server_version = "kiss-asr/1"

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/health"):
            try:
                urllib.request.urlopen(WHISPER.rsplit("/", 1)[0] + "/", timeout=3).read(10)
                ok = True
            except Exception:
                ok = False
            return self._send(200, {"ok": True, "whisper": ok})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.headers.get("X-Kiss-Asr") != "1":
            return self._send(403, {"error": "forbidden"})
        t0 = time.time()
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 8 * 1024 * 1024:
                return self._send(413, {"error": "size"})
            body = self.rfile.read(n)
            u = urlparse(self.path)
            if u.path == "/v1/asr":
                q = parse_qs(u.query)
                tr = q.get("translate", ["0"])[0] == "1"
                res = whisper(body, tr, q.get("prompt", [""])[0])
            elif u.path == "/v1/asr-url":
                j = json.loads(body)
                wav = slice_url(j["url"], float(j.get("start", 0)), float(j.get("duration", 10)), j.get("referer", ""))
                res = whisper(wav, bool(j.get("translate")), j.get("prompt", ""))
            else:
                return self._send(404, {"error": "not found"})
            res["ms"] = int((time.time() - t0) * 1000)
            self._send(200, res)
        except Exception as e:
            self._send(500, {"error": str(e)[:300]})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"kiss-asr listening on 127.0.0.1:{PORT}", file=sys.stderr, flush=True)
    srv.serve_forever()
