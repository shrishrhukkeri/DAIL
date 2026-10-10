# Caller — Dial 1400 voice line

Phone-style UI. Dial **1400** to start a two-way call powered by Groq:

1. **Whisper** (`whisper-large-v3-turbo`) — speech to text  
2. **LLM** (`qwen/qwen3.8-27b`) — reply text (streamed)  
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

1. Push this repo to GitHub.  
2. Create a **Web Service** on [Render](https://render.com).  
3. Settings:
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
   - **Environment:** `GROQ_API_KEY` = your Groq key  
4. Deploy and open the service URL. Dial `1400`.

## API

| Route | Purpose |
| --- | --- |
| `POST /api/transcribe` | multipart `audio` → `{ text }` |
| `POST /api/chat` | `{ messages }` → SSE token stream |
| `POST /api/speak` | `{ text }` → `audio/wav` |
| `GET /api/health` | liveness / key presence |
