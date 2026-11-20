/**
 * Josh fork: caption translation for any site with a <video>.
 *
 * Two paths, chosen per video:
 * 1. Text tracks (HTML5 <track>, hls.js/shaka/video.js cues): the source track is
 *    kept loaded but hidden, and an English track ("English (KISS)") is added to the
 *    same <video> with translated VTTCues. The browser renders it natively, so it
 *    works in fullscreen and inside iframes.
 * 2. DOM captions (players that draw their own caption elements: Netflix, Vimeo,
 *    Twitch, JW Player, video.js, Plyr, Shaka, Disney+, Prime, Bitmovin, embedded
 *    YouTube, and unknown players found by matching the active cue text or
 *    caption-like class names): the caption text is replaced in place with English.
 *
 * Output is English only: the original caption line is never shown next to it.
 * www.youtube.com keeps the upstream YouTube provider.
 */
import { apiTranslate } from "../apis/index.js";
import { resolveApiPromptSettings } from "../config/prompt.js";
import {
  availableApiForScene,
  withScenePrompt,
} from "../config/serviceSelection.js";
import { DEFAULT_SUBTITLE_SETTING } from "../config/setting.js";
import { logger } from "../libs/log.js";

const log = logger.child("generic-subtitle");

const OWN_TRACK_LABEL = "English (KISS)";
const DONE_ATTR = "data-kiss-caption";
const PREFETCH_SECONDS = 45;

// Known caption containers. Each match is treated as one caption block.
export const CAPTION_SELECTORS = [
  ".ytp-caption-segment", // embedded YouTube
  ".player-timedtext-text-container", // Netflix
  ".vp-captions", // Vimeo
  "[data-a-target='player-captions-container']", // Twitch
  ".player-captions-container", // Twitch (older)
  ".jw-text-track-cue", // JW Player
  ".vjs-text-track-cue", // video.js / Brightcove
  ".plyr__caption", // Plyr
  ".shaka-text-container", // Shaka
  ".dss-subtitle-renderer-cue", // Disney+
  ".atvwebplayersdk-captions-text", // Prime Video
  ".bmpui-ui-subtitle-label", // Bitmovin
  ".fp-captions", // Flowplayer
  ".mejs__captions-text", // MediaElement
  ".dmp_SubtitleText, .np_CaptionsText", // Dailymotion
  "[data-testid*='caption' i]",
  "[data-testid*='subtitle' i]",
];
// Generic fallback: caption-ish class names, only when inside a video player.
const GENERIC_CAPTION_SELECTOR =
  "[class*='caption' i], [class*='subtitle' i], [class*='timedtext' i], [class*='cue-text' i]";

const norm = (t) => (t || "").replace(/\s+/g, " ").trim();
const isEnglishLang = (lang) => /^en\b|^en[-_]/i.test(lang || "");

export function shouldRunGenericSubtitles(href) {
  try {
    const { hostname, pathname } = new URL(href);
    // Top-level YouTube watch pages use the upstream provider.
    if (
      /(^|\.)youtube\.com$/.test(hostname) &&
      !pathname.startsWith("/embed") &&
      window.top === window
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

class GenericVideoSubtitles {
  #setting;
  #subtitleSetting;
  #apiSetting;
  #toLang;
  #cache = new Map(); // original -> Promise<string>
  #videos = new WeakMap(); // video -> state
  #captionEls = new WeakMap(); // element -> { original, translated }
  #observer = null;
  #pending = new WeakSet();
  #scanTimer = 0;

  constructor(setting) {
    this.#setting = setting;
    this.#subtitleSetting = setting.subtitleSetting || DEFAULT_SUBTITLE_SETTING;
    this.#toLang = this.#subtitleSetting.toLang || "en";
    const api = availableApiForScene(
      this.#subtitleSetting,
      setting.transApis || [],
      "translate"
    );
    if (!api) throw new Error("no subtitle translation service");
    this.#apiSetting = resolveApiPromptSettings(
      withScenePrompt(api, this.#subtitleSetting),
      setting.prompts,
      this.#subtitleSetting
    );
  }

  start() {
    this.#scan();
    this.#observer = new MutationObserver((records) => this.#onMutations(records));
    this.#observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Players often attach tracks/cues after load (hls.js, shaka); rescan gently.
    this.#scanTimer = setInterval(() => this.#scan(), 3000);
  }

  translate(text) {
    const key = norm(text);
    if (!key) return Promise.resolve("");
    if (!this.#cache.has(key)) {
      const p = apiTranslate({
        text: key,
        fromLang: "auto",
        toLang: this.#toLang,
        apiSetting: this.#apiSetting,
        scene: this.#subtitleSetting,
        translateVariants: this.#setting.translateVariants ?? true,
      })
        .then((res) => (res?.isSame ? key : norm(res?.trText) || key))
        .catch((err) => {
          this.#cache.delete(key);
          log.warn("caption translate failed", err);
          return null;
        });
      this.#cache.set(key, p);
    }
    return this.#cache.get(key);
  }

  // ---------- video / text track path ----------
  #scan() {
    document.querySelectorAll("video").forEach((v) => this.#attachVideo(v));
  }

  #attachVideo(video) {
    let state = this.#videos.get(video);
    if (!state) {
      state = { video, source: null, own: null, domMode: false, done: new Set() };
      this.#videos.set(video, state);
      video.textTracks.addEventListener("change", () => this.#pickTrack(state));
      video.textTracks.addEventListener("addtrack", () => this.#pickTrack(state));
      video.addEventListener("timeupdate", () => this.#prefetch(state));
    }
    this.#pickTrack(state);
  }

  #candidateTracks(video) {
    return Array.from(video.textTracks).filter(
      (t) =>
        (t.kind === "subtitles" || t.kind === "captions") &&
        t.label !== OWN_TRACK_LABEL
    );
  }

  #pickTrack(state) {
    if (state.domMode) return;
    const tracks = this.#candidateTracks(state.video);
    if (!tracks.length) return;
    // Prefer the track the user/player turned on; else the first non-English one.
    const showing = tracks.find((t) => t.mode === "showing");
    const pick =
      showing ||
      (state.source && tracks.includes(state.source) && state.source) ||
      tracks.find((t) => t.mode === "hidden" && !isEnglishLang(t.language)) ||
      null;
    if (!pick) return;
    if (isEnglishLang(pick.language)) {
      // Already English: leave the native captions alone.
      if (state.own) state.own.mode = "disabled";
      return;
    }
    if (pick !== state.source) {
      state.source = pick;
      state.done = new Set();
      state.sourceWasShowing = pick.mode === "showing";
      pick.addEventListener("cuechange", () => this.#onCueChange(state, pick));
    }
    if (pick.mode === "showing") pick.mode = "hidden"; // keep cues, hide original
    if (!state.own) {
      state.own = state.video.addTextTrack("subtitles", OWN_TRACK_LABEL, "en");
    }
    state.own.mode = "showing";
    this.#prefetch(state);
  }

  #onCueChange(state, track) {
    if (track !== state.source || state.domMode) return;
    const active = Array.from(track.activeCues || []);
    active.forEach((cue) => this.#translateCue(state, cue));
    // Player draws hidden cues itself? Find its caption element by text.
    if (!state.sourceWasShowing && active.length) {
      const text = norm(active.map((c) => c.text).join(" ").replace(/<[^>]+>/g, ""));
      const el = this.#findCaptionByText(state.video, text);
      if (el) this.#switchToDomMode(state, el);
    }
    this.#prefetch(state);
  }

  #prefetch(state) {
    const track = state.source;
    if (!track || !track.cues || state.domMode) return;
    const now = state.video.currentTime || 0;
    for (const cue of Array.from(track.cues)) {
      if (cue.endTime < now - 1) continue;
      if (cue.startTime > now + PREFETCH_SECONDS) break;
      this.#translateCue(state, cue);
    }
  }

  #translateCue(state, cue) {
    const id = `${cue.startTime}|${cue.endTime}|${cue.text}`;
    if (state.done.has(id)) return;
    state.done.add(id);
    const text = norm(String(cue.text || "").replace(/<[^>]+>/g, ""));
    if (!text) return;
    this.translate(text).then((en) => {
      if (en == null) {
        state.done.delete(id);
        return;
      }
      if (!state.own || state.source?.cues == null) return;
      try {
        const out = new VTTCue(cue.startTime, cue.endTime, en);
        if (cue.line !== undefined && cue.line !== "auto") out.line = cue.line;
        state.own.addCue(out);
      } catch (err) {
        log.warn("add cue failed", err);
      }
    });
  }

  #playerRoot(video) {
    let el = video.parentElement;
    for (let i = 0; i < 5 && el?.parentElement; i++) {
      if (el.getBoundingClientRect().height > video.getBoundingClientRect().height * 1.6)
        break;
      el = el.parentElement;
    }
    return el || video.parentElement;
  }

  #findCaptionByText(video, text) {
    if (!text) return null;
    const root = this.#playerRoot(video);
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let best = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n === video || n.tagName === "VIDEO") continue;
      if (norm(n.textContent) === text) best = n; // deepest match wins
    }
    return best;
  }

  #switchToDomMode(state, el) {
    state.domMode = true;
    if (state.own) state.own.mode = "disabled";
    this.#handleCaptionEl(el.closest?.(CAPTION_SELECTORS.join(",")) || el);
  }

  // ---------- DOM caption path ----------
  #onMutations(records) {
    let sawVideo = false;
    const hasVideo = !!document.querySelector("video");
    for (const r of records) {
      if (r.type === "childList") {
        r.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.tagName === "VIDEO" || n.querySelector?.("video")) sawVideo = true;
          if (hasVideo) this.#collectCaptions(n);
        });
      }
      if (!hasVideo) continue;
      const target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (target) this.#maybeCaption(target);
    }
    if (sawVideo) this.#scan();
  }

  #collectCaptions(node) {
    if (node.matches?.(CAPTION_SELECTORS.join(","))) this.#handleCaptionEl(node);
    node
      .querySelectorAll?.(CAPTION_SELECTORS.join(","))
      .forEach((el) => this.#handleCaptionEl(el));
    this.#maybeCaption(node);
  }

  #maybeCaption(el) {
    if (!el?.closest) return;
    const known = el.closest(CAPTION_SELECTORS.join(","));
    if (known) return this.#handleCaptionEl(known);
    const generic = el.closest(GENERIC_CAPTION_SELECTOR);
    if (generic && this.#nearVideo(generic)) this.#handleCaptionEl(generic);
  }

  #nearVideo(el) {
    let a = el.parentElement;
    for (let i = 0; i < 6 && a; i++, a = a.parentElement) {
      if (a.querySelector("video")) return true;
    }
    return false;
  }

  #handleCaptionEl(el) {
    if (!el || this.#pending.has(el)) return;
    const text = norm(el.innerText || el.textContent);
    if (!text || text.length > 400) return;
    const prev = this.#captionEls.get(el);
    if (prev && (text === prev.translated || text === norm(prev.translated))) return;
    el.classList.add("notranslate");
    el.setAttribute("translate", "no");
    const cached = this.#cache.get(text);
    this.#pending.add(el);
    (cached || this.translate(text)).then((en) => {
      this.#pending.delete(el);
      if (en == null) return;
      // Only swap if the player has not moved on to another line.
      if (norm(el.innerText || el.textContent) !== text) return this.#handleCaptionEl(el);
      if (en === text) return;
      this.#captionEls.set(el, { original: text, translated: en });
      this.#replaceText(el, en);
      el.setAttribute(DONE_ATTR, "1");
    });
  }

  #replaceText(el, en) {
    // Keep the player's styled wrapper: put the English into the first text node
    // and clear the others, so line styling survives and no original text remains.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (norm(n.nodeValue)) nodes.push(n);
    }
    if (!nodes.length) return;
    nodes[0].nodeValue = en;
    for (let i = 1; i < nodes.length; i++) nodes[i].nodeValue = "";
    // Hide line breaks left between now-empty lines.
    el.querySelectorAll("br").forEach((br) => (br.style.display = "none"));
  }
}

export function runGenericSubtitles({ href, setting }) {
  try {
    const subtitleSetting = setting.subtitleSetting || DEFAULT_SUBTITLE_SETTING;
    if (!subtitleSetting.enabled) return null;
    if (!shouldRunGenericSubtitles(href)) return null;
    const runner = new GenericVideoSubtitles(setting);
    runner.start();
    return runner;
  } catch (err) {
    log.error("generic subtitles failed to start", err);
    return null;
  }
}
