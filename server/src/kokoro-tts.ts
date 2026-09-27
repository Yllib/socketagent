import * as path from "path";
import { isRecord } from "./value-guards";
import * as fs from "fs";
import { socketAgentDataPath } from "./socket-agent-paths";

const MODEL_DIR = path.join(
  socketAgentDataPath("tts-models"),
  "kokoro-en-v0_19"
);

// Kokoro English voice name → speaker ID mapping
export const KOKORO_VOICES: Record<string, number> = {
  af_heart: 0,
  af_bella: 1,
  af_nicole: 2,
  af_sarah: 3,
  af_sky: 4,
  am_adam: 5,
  am_michael: 6,
  bf_emma: 7,
  bf_isabella: 8,
  bm_george: 9,
  bm_lewis: 10,
};

interface KokoroAudio { samples: Float32Array; sampleRate: number }
interface KokoroTts {
  numSpeakers: number;
  sampleRate: number;
  generate(request: { text: string; sid: number; speed: number }): KokoroAudio;
}
interface SherpaRuntime {
  create(config: object): KokoroTts;
  writeWave(file: string, audio: KokoroAudio): void;
}
let sherpaOnnx: SherpaRuntime | null = null;
let ttsInstance: KokoroTts | null = null;

// The optional native package has no TypeScript declarations. Check its exports
// and generated audio at the boundary while retaining lazy platform loading.
function loadSherpaOnnx(): SherpaRuntime | null {
  if (!sherpaOnnx) {
    try {
      const module: unknown = require("sherpa-onnx-node");
      if (!isRecord(module) || typeof module.OfflineTts !== "function" || typeof module.writeWave !== "function") {
        throw new Error("Invalid sherpa-onnx-node exports");
      }
      const OfflineTts = module.OfflineTts;
      const writeWave = module.writeWave;
      sherpaOnnx = {
        create(config) {
          const instance: unknown = Reflect.construct(OfflineTts, [config]);
          if (!isRecord(instance) || typeof instance.numSpeakers !== "number"
            || typeof instance.sampleRate !== "number" || typeof instance.generate !== "function") {
            throw new Error("Invalid sherpa-onnx-node TTS instance");
          }
          const generate = instance.generate;
          return {
            numSpeakers: instance.numSpeakers, sampleRate: instance.sampleRate,
            generate(request) {
              const audio: unknown = generate.call(instance, request);
              if (!isRecord(audio) || !(audio.samples instanceof Float32Array) || typeof audio.sampleRate !== "number") {
                throw new Error("Invalid sherpa-onnx-node audio");
              }
              return { samples: audio.samples, sampleRate: audio.sampleRate };
            },
          };
        },
        writeWave(file, audio) { writeWave.call(module, file, audio); },
      };
    } catch (e) {
      console.error("[KokoroTTS] Failed to load sherpa-onnx-node:", e);
      return null;
    }
  }
  return sherpaOnnx;
}

export function isKokoroAvailable(): boolean {
  return fs.existsSync(path.join(MODEL_DIR, "model.onnx"));
}

function ensureInitialized(): boolean {
  if (ttsInstance) return true;

  const so = loadSherpaOnnx();
  if (!so) return false;

  if (!isKokoroAvailable()) {
    console.warn("[KokoroTTS] Model not found at", MODEL_DIR);
    return false;
  }

  try {
    console.log("[KokoroTTS] Loading Kokoro model...");
    const config = {
      model: {
        kokoro: {
          model: path.join(MODEL_DIR, "model.onnx"),
          voices: path.join(MODEL_DIR, "voices.bin"),
          tokens: path.join(MODEL_DIR, "tokens.txt"),
          dataDir: path.join(MODEL_DIR, "espeak-ng-data"),
          lengthScale: 1.0,
        },
      },
      numThreads: 2,
      provider: "cpu",
      maxNumSentences: 2,
    };
    ttsInstance = so.create(config);
    console.log(`[KokoroTTS] Model loaded — ${ttsInstance.numSpeakers} speakers, ${ttsInstance.sampleRate}Hz`);
    return true;
  } catch (e) {
    console.error("[KokoroTTS] Failed to initialize:", e);
    return false;
  }
}

/**
 * Generate WAV audio from text using Kokoro TTS.
 * Returns a Buffer containing the WAV file, or null on failure.
 */
export function generateKokoroAudio(
  text: string,
  voice: string = "af_heart",
  speed: number = 1.0
): Buffer | null {
  if (!ensureInitialized()) return null;

  const so = loadSherpaOnnx();
  if (!so || !ttsInstance) return null;
  const sid = KOKORO_VOICES[voice] ?? 0;
  try {
    const audio = ttsInstance.generate({ text, sid, speed });
    const tmpPath = `/tmp/kokoro_tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`;
    so.writeWave(tmpPath, { samples: audio.samples, sampleRate: audio.sampleRate });
    const wavBuffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);
    return wavBuffer;
  } catch (e) {
    console.error("[KokoroTTS] Generation failed:", e);
    return null;
  }
}

export function freeKokoroTts(): void {
  ttsInstance = null;
}
