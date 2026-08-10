import * as path from "path";
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

let sherpaOnnx: any = null;
let ttsInstance: any = null;

function loadSherpaOnnx(): any {
  if (!sherpaOnnx) {
    try {
      sherpaOnnx = require("sherpa-onnx-node");
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
    ttsInstance = new so.OfflineTts(config);
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

function samplesToWavBuffer(samples: Float32Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
    wav.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return wav;
}

/**
 * Generate one context-aware utterance asynchronously while forwarding audio
 * chunks as soon as Kokoro makes them available. The complete text is passed
 * to the model once, so streaming playback does not sacrifice sentence or
 * paragraph context.
 */
export async function generateKokoroAudioStream(
  text: string,
  voice: string = "af_heart",
  speed: number = 1.0,
  onChunk: (wav: Buffer, index: number) => void,
): Promise<boolean> {
  if (!ensureInitialized()) return false;

  const sid = KOKORO_VOICES[voice] ?? 0;
  let chunkCount = 0;
  try {
    const audio = await ttsInstance.generateAsync({
      text,
      sid,
      speed,
      onProgress: (info: { samples?: Float32Array }) => {
        const samples = info?.samples;
        if (!samples || samples.length === 0) return 1;
        onChunk(samplesToWavBuffer(samples, ttsInstance.sampleRate), chunkCount++);
        return 1;
      },
    });
    // Older native bindings may complete asynchronously without progress
    // callbacks. Preserve compatibility by sending the final audio once.
    if (chunkCount === 0 && audio?.samples?.length) {
      onChunk(samplesToWavBuffer(audio.samples, audio.sampleRate || ttsInstance.sampleRate), 0);
      chunkCount = 1;
    }
    return chunkCount > 0;
  } catch (e) {
    console.error("[KokoroTTS] Streaming generation failed:", e);
    return false;
  }
}

export function freeKokoroTts(): void {
  ttsInstance = null;
}
