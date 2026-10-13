# Caller — Dial 1400 voice line

Phone-style UI. Dial **1400** to start a two-way call powered by Groq:

1. **Whisper** (`whisper-large-v3-turbo`) — speech to text  
2. **LLM** (`openai/gpt-oss-20b`) — reply text (streamed; Llama 3.1 8B replacement on Groq)  
3. **Orpheus TTS** (`canopylabs/orpheus-v1-english`) — spoken audio (falls back to browser TTS if Orpheus terms are not accepted yet)  

**One-time Groq step:** open [Orpheus in the Groq Playground](https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english) and accept the model terms so API TTS works.

Any other number plays the existing wrong-number audio.

## Local setup

```bash
cp .env.example .env
# put your GROQ_API_KEY in .env

npm install
npm run dev
```

- Client: http://localhost:5173 (Vite proxies `/api` → Express)  
- API: http://localhost:3001  

Production-style locally:

```bash
npm run build
npm start
# open http://localhost:3001
```

## Conversation

After dialing **1400**, the mic stays open. Speak naturally — when you pause (~0.5s), your turn is sent to Whisper → LLM → TTS. You can interrupt the AI by talking over it. Use the mic button to mute/unmute.

## Deploy on Render

This repo includes [`render.yaml`](render.yaml).

1. Push to **GitHub** (Render cannot pull from Cursor Origin).  
2. In [Render](https://dashboard.render.com): **New → Blueprint** (or Web Service) and select the repo.  
3. Set secret env var `GROQ_API_KEY`.  
4. Build: `npm install --include=dev && npm run build` · Start: `npm start`  
5. Open the `*.onrender.com` URL and dial `1400`.

Free tier spins down after idle — first request after sleep can take ~30s.

## API

| Route | Purpose |
| --- | --- |
| `POST /api/transcribe` | multipart `audio` → `{ text }` |
| `POST /api/chat` | `{ messages }` → SSE token stream |
| `POST /api/speak` | `{ text }` → `audio/wav` |
| `GET /health` | liveness (for cron keep-alive) |
| `GET /api/health` | same as `/health` |

### Keep Render awake (cron-job.org)

1. Create a job at [cron-job.org](https://cron-job.org)  
2. URL: `https://YOUR-SERVICE.onrender.com/health`  
3. Schedule: every **10–14 minutes** (GET)  
4. Expect **200** with `{ "ok": true, "status": "up", ... }`
