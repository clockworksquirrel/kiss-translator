/**
 * Josh fork: live speech-to-text subtitles for any <video>, no captions needed.
 *
 * Audio comes from the video itself:
 *  - video.captureStream() for same-origin / MSE (blob:) / CORS media (YouTube,
 *    most streaming players, Wikimedia, archive.org with CORS). PCM is cut at
 *    pauses into 1.5-6 s chunks, so words are rarely split, and sent to the local
 *    Whisper bridge (http://127.0.0.1:8177, via the background worker).
 *  - When the browser refuses to capture (cross-origin media without CORS) and
 *    the source is a plain http(s) file, the local bridge pulls that slice of
 *    the file with ffmpeg instead, a few seconds ahead of playback, so those
 *    subtitles land on time.
 * Whisper (large-v3-turbo, local) transcribes; non-English text is translated
 * by the extension's own subtitle translator. Output is an English-only text
 * track ("English (KISS live)") rendered natively by the browser.
 */
import { browser } from "../libs/browser.js";
import { MSG_LIVE_ASR } from "../config/msg.js";
import { logger } from "../libs/log.js";

const log = logger.child("live-asr");

export const LIVE_TRACK_LABEL = "English (KISS live)";
const SR = 16000;
const MIN_CHUNK = 1.5; // seconds
const CUT_AFTER = 2.0; // start looking for a pause after this
const MAX_CHUNK = 6.0; // hard cut
const PAUSE_MS = 220; // silence that counts as a pause
const URL_WINDOW = 8; // seconds per slice in URL mode
const URL_AHEAD = 20; // keep this many seconds transcribed ahead (URL mode)

const isEnglish = (lang) => /^(en|english)$/i.test(String(lang || "").trim());
const norm = (t) => (t || "").replace(/\s+/g, " ").trim();

function wavBase64(pcm) {
  const n = pcm.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function downsample(input, fromRate) {
  if (fromRate === SR) return Float32Array.from(input);
  const ratio = fromRate / SR;
  const len = Math.floor(input.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

const rms = (a) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / (a.length || 1));
};

/** One video's live transcription. */
export class LiveVideoAsr {
  #video;
  #translate;
  #track = null;
  #mode = null; // "stream" | "url" | "off"
  #ctx = null;
  #nodes = [];
  #chunks = [];
  #chunkSamples = 0;
  #chunkVideoStart = 0;
  #quietMs = 0;
  #speechLevel = 0.02;
  #queue = [];
  #busy = false;
  #prompt = "";
  #lastCue = null;
  #urlNext = 0;
  #urlBusy = false;
  #urlTimer = 0;
  #stopped = false;
  #listeners = [];
  #resumeHandler = null;
  stats = { chunks: 0, cues: 0, lastLatencyMs: 0, mode: null, errors: 0 };

  constructor(video, { translate }) {
    this.#video = video;
    this.#translate = translate;
  }

  get running() {
    return !this.#stopped && !!this.#mode && this.#mode !== "off";
  }

  start() {
    if (this.running) return;
    this.#stopped = false;
    this.#ensureTrack();
    this.#track.mode = "showing";
    if (!this.#startStream()) this.#startUrlMode();
    this.stats.mode = this.#mode;
    this.#publish();
    this.#on(this.#video, "seeking", () => this.#reset());
    this.#on(this.#video, "pause", () => this.#flush());
    this.#on(this.#video, "emptied", () => this.#reset());
    log.info("live subtitles started", this.#mode);
  }

  stop() {
    this.#stopped = true;
    this.#mode = "off";
    clearInterval(this.#urlTimer);
    this.#nodes.forEach((n) => {
      try {
        n.disconnect();
      } catch {}
    });
    this.#nodes = [];
    try {
      this.#ctx?.close();
    } catch {}
    this.#ctx = null;
    this.#listeners.forEach(([t, e, f]) => t.removeEventListener(e, f, true));
    this.#listeners = [];
    if (this.#track) this.#track.mode = "disabled";
    this.stats.mode = "off";
    this.#publish();
    this.#chunks = [];
    this.#chunkSamples = 0;
    this.#queue = [];
  }

  #publish() {
    try {
      this.#video.dataset.kissLive = JSON.stringify(this.stats);
    } catch {}
  }

  #on(target, ev, fn) {
    target.addEventListener(ev, fn, true);
    this.#listeners.push([target, ev, fn]);
  }

  #ensureTrack() {
    if (this.#track) return;
    const existing = Array.from(this.#video.textTracks).find(
      (t) => t.label === LIVE_TRACK_LABEL
    );
    this.#track =
      existing || this.#video.addTextTrack("subtitles", LIVE_TRACK_LABEL, "en");
  }

  // ---------- capture via captureStream ----------
  #startStream() {
    const v = this.#video;
    let stream;
    try {
      stream = (v.captureStream || v.mozCaptureStream).call(v);
    } catch (err) {
      log.info("captureStream refused", err?.name || err);
      return false;
    }
    if (!stream) return false;
    this.#mode = "stream";
    const hook = () => {
      const track = stream.getAudioTracks()[0];
      if (!track || this.#ctx) return !!track;
      this.#wireAudio(track);
      return true;
    };
    if (!hook()) stream.addEventListener("addtrack", hook);
    return true;
  }

  #wireAudio(track) {
    const ctx = new AudioContext();
    this.#ctx = ctx;
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0; // never play the captured audio a second time
    src.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
    this.#nodes = [src, proc, sink];
    proc.onaudioprocess = (e) => this.#onAudio(e.inputBuffer, ctx.sampleRate);
    if (ctx.state !== "running") {
      // Autoplay policy: resume on the next user gesture.
      this.#resumeHandler = () => ctx.resume().catch(() => {});
      ["pointerdown", "keydown"].forEach((ev) =>
        this.#on(window, ev, this.#resumeHandler)
      );
      this.#on(this.#video, "play", this.#resumeHandler);
      ctx.resume().catch(() => {});
    }
  }

  #onAudio(buffer, rate) {
    const v = this.#video;
    if (this.#stopped || v.paused || v.seeking) return;
    const data = buffer.getChannelData(0);
    const pcm = downsample(data, rate);
    const level = rms(pcm);
    const blockMs = (pcm.length / SR) * 1000;
    if (!this.#chunkSamples) {
      this.#chunkVideoStart = Math.max(0, v.currentTime - buffer.duration);
    }
    this.#chunks.push(pcm);
    this.#chunkSamples += pcm.length;
    if (level > 0.01)
      this.#speechLevel = this.#speechLevel * 0.95 + level * 0.05;
    const quiet = level < Math.max(0.003, this.#speechLevel * 0.25);
    this.#quietMs = quiet ? this.#quietMs + blockMs : 0;
    const secs = this.#chunkSamples / SR;
    if (
      secs >= MAX_CHUNK ||
      (secs >= CUT_AFTER && this.#quietMs >= PAUSE_MS) ||
      (secs >= MIN_CHUNK && this.#quietMs >= PAUSE_MS * 3)
    ) {
      this.#flush();
    }
  }

  #flush() {
    if (!this.#chunkSamples) return;
    const pcm = new Float32Array(this.#chunkSamples);
    let o = 0;
    for (const c of this.#chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    const start = this.#chunkVideoStart;
    this.#chunks = [];
    this.#chunkSamples = 0;
    this.#quietMs = 0;
    if (pcm.length < SR * 0.6) return;
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 160) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak < 0.01) return; // silence: Whisper would only hallucinate
    this.#queue.push({ pcm, start, rate: this.#video.playbackRate || 1, at: performance.now() });
    while (this.#queue.length > 2) this.#queue.shift(); // stay live
    this.#pump();
  }

  async #pump() {
    if (this.#busy || !this.#queue.length) return;
    this.#busy = true;
    const job = this.#queue.shift();
    try {
      const res = await browser.runtime.sendMessage({
        action: MSG_LIVE_ASR,
        args: { wav: wavBase64(job.pcm), prompt: this.#prompt },
      });
      if (res?.error) throw new Error(res.error);
      this.stats.chunks++;
      if (!this.#stopped) await this.#show(res, job.start, job.rate, false);
      this.stats.lastLatencyMs = Math.round(performance.now() - job.at);
      this.stats.asrMs = res?.ms;
      this.stats.language = res?.language;
      this.stats.lastText = this.#lastCue?.text;
      this.#publish();
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = String(err?.message || err).slice(0, 200);
      this.#publish();
      log.warn("live asr chunk failed", err?.message || err);
    } finally {
      this.#busy = false;
      if (this.#queue.length) this.#pump();
    }
  }

  // ---------- URL mode (cross-origin files) ----------
  #startUrlMode() {
    const src = this.#video.currentSrc || this.#video.src;
    if (!/^https?:/i.test(src || "")) {
      this.#mode = "off";
      log.info("no capturable audio for this video");
      return;
    }
    this.#mode = "url";
    this.#urlNext = Math.max(0, this.#video.currentTime - 0.5);
    this.#urlTimer = setInterval(() => this.#urlTick(), 700);
    this.#urlTick();
  }

  async #urlTick() {
    const v = this.#video;
    if (this.#stopped || this.#urlBusy || v.paused) return;
    const now = v.currentTime;
    if (this.#urlNext < now - 1 || this.#urlNext > now + URL_AHEAD + URL_WINDOW)
      this.#urlNext = Math.max(0, now - 0.5); // seeked
    if (this.#urlNext > now + URL_AHEAD) return;
    if (Number.isFinite(v.duration) && this.#urlNext >= v.duration) return;
    const start = this.#urlNext;
    this.#urlBusy = true;
    const t0 = performance.now();
    try {
      const res = await browser.runtime.sendMessage({
        action: MSG_LIVE_ASR,
        args: {
          url: v.currentSrc || v.src,
          start,
          duration: URL_WINDOW,
          referer: window.location.href,
          prompt: this.#prompt,
        },
      });
      if (res?.error) throw new Error(res.error);
      this.stats.chunks++;
      this.stats.lastLatencyMs = Math.round(performance.now() - t0);
      if (start === this.#urlNext) this.#urlNext = start + URL_WINDOW;
      if (!this.#stopped) await this.#show(res, start, 1, true);
      this.stats.asrMs = res?.ms;
      this.stats.language = res?.language;
      this.stats.lastText = this.#lastCue?.text;
      this.#publish();
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = String(err?.message || err).slice(0, 200);
      this.#publish();
      log.warn("live asr url slice failed", err?.message || err);
      if (this.stats.errors > 5 && !this.stats.cues) this.stop();
    } finally {
      this.#urlBusy = false;
    }
  }

  // ---------- render ----------
  #reset() {
    this.#chunks = [];
    this.#chunkSamples = 0;
    this.#queue = [];
    this.#prompt = "";
    this.#lastCue = null;
    if (this.#mode === "url") this.#urlNext = Math.max(0, this.#video.currentTime - 0.5);
  }

  async #show(res, chunkStart, rate, onTimeline) {
    const segs = (res?.segments || []).filter((s) => norm(s.text));
    if (!segs.length) return;
    const text = norm(segs.map((s) => s.text).join(" "));
    this.#prompt = text.slice(-200);
    let lines;
    if (isEnglish(res.language)) {
      lines = segs.map((s) => ({ s: s.start, e: s.end, text: norm(s.text) }));
    } else {
      const en = norm(await this.#translate(text));
      if (!en) return;
      // Spread the translation over the chunk, split at sentence ends.
      const parts = en.match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [en];
      const merged = [];
      for (const p of parts) {
        const last = merged[merged.length - 1];
        if (last && (last + p).length <= 90) merged[merged.length - 1] = last + p;
        else merged.push(p);
      }
      const s0 = segs[0].start;
      const s1 = segs[segs.length - 1].end;
      const total = merged.reduce((n, p) => n + p.length, 0) || 1;
      let acc = s0;
      lines = merged.map((p) => {
        const d = ((s1 - s0) * p.length) / total;
        const l = { s: acc, e: acc + d, text: norm(p) };
        acc += d;
        return l;
      });
    }
    const v = this.#video;
    if (!onTimeline) {
      // Live mode: the speech already played. Group lines (max 2 lines, ~120
      // chars per cue) and show them one after another from now on.
      const groups = [];
      for (const l of lines) {
        const g = groups[groups.length - 1];
        if (g && g.n < 2 && (g.text + " " + l.text).length <= 120) {
          g.text += "\n" + l.text;
          g.e = l.e;
          g.n++;
        } else groups.push({ s: l.s, e: l.e, text: l.text, n: 1 });
      }
      lines = groups;
    }
    let cursor = v.currentTime;
    for (const l of lines) {
      let start = chunkStart + l.s * rate;
      let end = chunkStart + l.e * rate;
      const minDur = Math.min(6, 1.2 + l.text.split(/\s+/).length * 0.28);
      if (!onTimeline) {
        // Live mode: the speech already played; show it now, for long enough to read.
        if (start < cursor) start = cursor;
        end = Math.max(end, start + minDur);
        cursor = end;
      } else {
        end = Math.max(end, start + Math.min(minDur, 2.5));
      }
      if (this.#lastCue && this.#lastCue.endTime > start && this.#lastCue.startTime < start)
        this.#lastCue.endTime = start;
      try {
        const cue = new VTTCue(start, end, l.text);
        cue.line = -2;
        this.#track.addCue(cue);
        this.#lastCue = cue;
        this.stats.cues++;
      } catch (err) {
        log.warn("add live cue failed", err);
      }
    }
  }
}
