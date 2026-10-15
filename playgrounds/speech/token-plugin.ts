// Dev-server only: POST /api/stt-token returns a single-use ElevenLabs Scribe
// token, so the API key (ELEVENLABS_API_KEY in .env) never reaches the page.
import { type Plugin, loadEnv } from "vite";

export function sttToken(): Plugin {
  let key = "";
  return {
    name: "stt-token",
    apply: "serve",
    configResolved(config) {
      key = loadEnv(config.mode, config.root, "").ELEVENLABS_API_KEY ?? "";
    },
    configureServer(server) {
      server.middlewares.use("/api/stt-token", async (req, res) => {
        const json = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        if ((req as { method?: string }).method !== "POST") return json(405, { error: "POST only" });
        if (!key) return json(500, { error: "ELEVENLABS_API_KEY is not set in .env" });
        try {
          const r = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", { method: "POST", headers: { "xi-api-key": key } });
          if (!r.ok) return json(502, { error: `ElevenLabs token: HTTP ${r.status} ${(await r.text()).slice(0, 200)}` });
          const { token } = (await r.json()) as { token: string };
          json(200, { token, url: "wss://api.elevenlabs.io/v1/speech-to-text/realtime" });
        } catch (err) {
          json(502, { error: `ElevenLabs token: ${err instanceof Error ? err.message : String(err)}` });
        }
      });
    },
  };
}
