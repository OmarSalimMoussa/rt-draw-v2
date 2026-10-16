// Dev-server only: POST /api/tts {text, voice} speaks the text with ElevenLabs
// (ELEVENLABS_API_KEY in .env, never sent to the page) and answers the audio
// with each word's start and end, so a page can play it and time things to it.
// Paid per character: replies are kept in .data/tts/ by text and voice, so the
// same line is only ever bought once, and every call is logged to .data/tts-calls.jsonl.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Plugin, loadEnv } from "vite";

/** The voices a page may ask for, by short name. */
export const VOICES: Record<string, string> = { will: "bIHbv24MWmeRgasZH58o", sarah: "EXAVITQu4vr4xnSDxMaL" };
const MODEL = "eleven_v4";
const MAX_CHARS = 600;

export type TtsReply = { audio: string; words: { word: string; start: number; end: number }[]; cached: boolean; chars: number };

/** Words with times from ElevenLabs' per-character alignment: split at whitespace. */
function words(a: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }) {
  const out: TtsReply["words"] = [];
  let w = "";
  let start = 0;
  let end = 0;
  a.characters.forEach((c, i) => {
    if (/\s/.test(c)) {
      if (w) out.push({ word: w, start, end });
      w = "";
    } else {
      if (!w) start = a.character_start_times_seconds[i];
      w += c;
      end = a.character_end_times_seconds[i];
    }
  });
  if (w) out.push({ word: w, start, end });
  return out;
}

export function ttsApi(): Plugin {
  let key = "";
  let dir = "";
  return {
    name: "tts-api",
    apply: "serve",
    configResolved(config) {
      key = loadEnv(config.mode, config.root, "").ELEVENLABS_API_KEY ?? "";
      dir = join(config.root, ".data");
    },
    configureServer(server) {
      server.middlewares.use("/api/tts", async (req, res) => {
        const json = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        if ((req as { method?: string }).method !== "POST") return json(405, { error: "POST only" });
        let body: { text?: string; voice?: string };
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return json(400, { error: "bad JSON" });
        }
        const text = (body.text ?? "").trim();
        const voice = VOICES[body.voice ?? "will"];
        if (!text || text.length > MAX_CHARS) return json(400, { error: `text must be 1-${MAX_CHARS} characters` });
        if (!voice) return json(400, { error: `unknown voice (${Object.keys(VOICES).join(", ")})` });
        const file = join(dir, "tts", `${createHash("sha256").update(`${MODEL}\n${voice}\n${text}`).digest("hex").slice(0, 32)}.json`);
        const log = (rec: Record<string, unknown>) => {
          try {
            appendFileSync(join(dir, "tts-calls.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), voice: body.voice, model: MODEL, chars: text.length, ...rec })}\n`);
          } catch {}
        };
        if (existsSync(file)) {
          log({ cached: true });
          return json(200, { ...JSON.parse(readFileSync(file, "utf8")), cached: true });
        }
        if (!key) return json(500, { error: "ELEVENLABS_API_KEY is not set in .env" });
        try {
          const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
            method: "POST",
            headers: { "xi-api-key": key, "content-type": "application/json" },
            body: JSON.stringify({ text, model_id: MODEL }),
          });
          if (!r.ok) {
            const error = `ElevenLabs: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
            log({ error });
            return json(502, { error });
          }
          const j = (await r.json()) as { audio_base64: string; alignment: Parameters<typeof words>[0] };
          const reply = { audio: j.audio_base64, words: words(j.alignment), chars: text.length };
          mkdirSync(join(dir, "tts"), { recursive: true });
          writeFileSync(file, JSON.stringify(reply));
          log({ cached: false });
          json(200, { ...reply, cached: false });
        } catch (err) {
          json(502, { error: `ElevenLabs: ${err instanceof Error ? err.message : String(err)}` });
        }
      });
    },
  };
}
