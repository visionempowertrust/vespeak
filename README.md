# VE Speak

A voice-first field feedback application for events and school sessions. It captures event details and audio, uses Sarvam AI's Saaras v3 for native-language transcription and English translation, stores records and private audio in Supabase, and provides an operations dashboard with on-demand English text to speech.

## Run locally

1. Install Node.js 18 or newer.
2. In Supabase project `yhaloppwmvdyzssknkpc`, open the SQL editor and run `supabase/schema.sql` once. This creates the private `field-audio` bucket and `field_feedback` table.
3. Copy `.env.example` to `.env`. Add the Sarvam API key and the Supabase secret/service-role key from **Settings → API Keys**. Set a dashboard passcode.
4. Run `npm start`.
5. Open `http://localhost:3000`; the dashboard is at `http://localhost:3000/dashboard.html`.

No npm packages are required; the app uses Node's built-in HTTP server and web APIs.

Audio is stored in the private Supabase Storage bucket and metadata in Postgres. The browser recorder stops automatically at the synchronous Sarvam endpoint's 30-second limit. The dashboard requests Bulbul v3 English speech on demand and does not store generated speech.

The Supabase secret key, Sarvam key, and dashboard passcode are server-only. Never expose them in client-side code. Serve production deployments only over HTTPS and use a full identity provider when access needs per-user auditability.
