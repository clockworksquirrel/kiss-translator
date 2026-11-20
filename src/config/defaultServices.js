import {
  DEFAULT_API_LIST,
  OPT_TRANS_LOCALAI,
  OPT_TRANS_SYSTEM_TTS,
} from "./api";
import { resolveBuiltinCapabilities } from "../builtin-plugins/capabilities";
import { OPT_TRANS_OPENAI, PINCHPOINT_API_SLUG } from "./apiConstants";
export { PINCHPOINT_API_SLUG };

// Josh's fork: default translator is the local Qwen3 model on PinchPoint
// (llama.cpp, OpenAI-compatible). The key is injected at build time from the
// untracked .env.local (REACT_APP_PINCHPOINT_KEY) and never committed.
export const pinchpointService = () => {
  const openai = DEFAULT_API_LIST.find((api) => api.apiType === OPT_TRANS_OPENAI);
  return {
    ...openai,
    apiSlug: PINCHPOINT_API_SLUG,
    apiName: "PinchPoint Local (Qwen3-30B-A3B)",
    apiType: OPT_TRANS_OPENAI,
    url: "https://direct-api.pinchpoint.cloud/local/v1/chat/completions",
    modelListUrl: "https://direct-api.pinchpoint.cloud/local/v1/models",
    key: process.env.REACT_APP_PINCHPOINT_KEY || "",
    model: "qwen3-30b-a3b",
    // Qwen3: turn thinking off so only the translation comes back.
    customBody: '{"chat_template_kwargs":{"enable_thinking":false}}',
    thinkingMode: "disabled",
    thinkingEffort: "_default",
    temperature: 0,
    maxTokens: 4096, // server context is 8192 tokens
    batchLength: 3000,
    batchSize: 15,
    batchConcurrency: 4,
    fetchLimit: 4,
    isDisabled: false,
    sortOrder: -1,
  };
};

/** Installed settings keep their own list; these instances are only initial defaults. */
export function defaultServices(client = process.env.REACT_APP_CLIENT) {
  if (!["chrome", "edge", "firefox"].includes(client))
    return [pinchpointService(), ...DEFAULT_API_LIST];
  const local = DEFAULT_API_LIST.find(
    (api) => api.apiType === OPT_TRANS_LOCALAI
  );
  const instances = [
    ["LocalAI-JEV", "LocalAI JEV", "laya-multilingual-int8", "webgpu"],
    ["LocalAI-ASR", "LocalAI ASR", "whisper-small-timestamped", "webgpu"],
    ["LocalAI-OCR", "LocalAI OCR", "ppocr-v6-medium", "webgpu"],
    ["LocalAI-VLM", "LocalAI VLM", "paddleocr-vl-1.6-onnx-q8", "webgpu"],
    ["LocalAI-Translation", "LocalAI 翻译", "hy-mt2-1.8b", "webgpu"],
    ["LocalAI-Layout", "LocalAI 版面分析", "pp-doclayout-v3-onnx", "wasm"],
  ].map(([apiSlug, apiName, modelRef, device]) => {
    const api = {
      ...local,
      apiSlug,
      apiName,
      modelRef,
      device,
      isDisabled: false,
      sortOrder: 0,
    };
    return {
      ...api,
      enabledCapabilities: Object.keys(resolveBuiltinCapabilities(api)),
    };
  });
  return [pinchpointService()].concat(DEFAULT_API_LIST.flatMap((api) => {
    if (api.apiType === OPT_TRANS_LOCALAI) return instances;
    return api.apiType === OPT_TRANS_SYSTEM_TTS
      ? [
          {
            ...api,
            isDisabled: false,
            sortOrder: 0,
            enabledCapabilities: ["speak"],
          },
        ]
      : [api];
  }));
}
