# VE Speak

A voice-first field feedback application for events and school sessions. It captures event details, a short audio observation, an optional context note, and uses Sarvam AI's Saaras v3 model to transcribe Indian regional languages.

## Run locally

1. Install Node.js 18 or newer.
2. Copy `.env.example` to `.env` and add your Sarvam API key.
3. Run `npm start`.
4. Open `http://localhost:3000`.

No npm packages are required; the app uses Node's built-in HTTP server and web APIs.

Submitted metadata is stored in `data/feedback.json` and audio in `data/audio/`. Both are ignored by Git. The browser recorder stops automatically at the synchronous Sarvam endpoint's 30-second limit.

For production, replace local file storage with authenticated object storage and a database, add access controls, and serve only over HTTPS.
