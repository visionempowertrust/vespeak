const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://yhaloppwmvdyzssknkpc.supabase.co").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "field-audio";
const MIME_TYPES = {
  ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8",
  ".js":"application/javascript; charset=utf-8", ".svg":"image/svg+xml", ".png":"image/png"
};

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type":"application/json; charset=utf-8", "Content-Length":Buffer.byteLength(body), "Cache-Control":"no-store" });
  res.end(body);
}

function sendError(res, error) {
  console.error(error);
  if (!res.headersSent) sendJson(res, error.status || 500, { error:error.message || "Something went wrong." });
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("Request is too large."), { status:413 }));
        req.destroy(); return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, 100 * 1024);
  try { return JSON.parse(raw.toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Invalid JSON request."), { status:400 }); }
}

function parseMultipart(buffer, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw Object.assign(new Error("Invalid form upload."), { status:400 });
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const fields = {}; let file = null; let cursor = 0;
  while (true) {
    const start = buffer.indexOf(boundary, cursor); if (start < 0) break;
    const headerStart = start + boundary.length + 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), headerStart); if (headerEnd < 0) break;
    const next = buffer.indexOf(boundary, headerEnd + 4); if (next < 0) break;
    const headers = buffer.subarray(headerStart, headerEnd).toString("utf8");
    const content = buffer.subarray(headerEnd + 4, next - 2);
    const name = headers.match(/name="([^"]+)"/i)?.[1];
    const filename = headers.match(/filename="([^"]*)"/i)?.[1];
    const type = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream";
    if (name && filename !== undefined) file = { filename:path.basename(filename || "recording.webm"), type, content };
    else if (name) fields[name] = content.toString("utf8");
    cursor = next;
  }
  return { fields, file };
}

function validateSubmission(fields, file) {
  for (const key of ["eventDate","eventName","state","school"]) {
    if (!fields[key]?.trim()) throw Object.assign(new Error("Please complete all event and school details."), { status:400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.eventDate)) throw Object.assign(new Error("Please provide a valid event date."), { status:400 });
  if (!file?.content?.length) throw Object.assign(new Error("Please record or choose an audio file."), { status:400 });
  if (!file.type.startsWith("audio/") && file.type !== "video/webm") throw Object.assign(new Error("The uploaded file must be audio."), { status:400 });
}

function baseMimeType(type = "") {
  return type.split(";", 1)[0].trim().toLowerCase();
}

function requireSarvam() {
  if (!process.env.SARVAM_API_KEY) throw Object.assign(new Error("Sarvam API is not configured."), { status:503 });
}

function requireSupabase() {
  if (!SUPABASE_KEY) throw Object.assign(new Error("Supabase is not configured. Add SUPABASE_SERVICE_ROLE_KEY to .env."), { status:503 });
}

async function sarvamSpeechToText(file, languageCode, mode) {
  requireSarvam();
  const form = new FormData();
  form.append("file", new Blob([file.content], { type:baseMimeType(file.type) }), file.filename);
  form.append("model", "saaras:v3");
  form.append("mode", mode);
  form.append("language_code", languageCode || "unknown");
  const response = await fetch("https://api.sarvam.ai/speech-to-text", {
    method:"POST", headers:{ "api-subscription-key":process.env.SARVAM_API_KEY }, body:form, signal:AbortSignal.timeout(60000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = result?.error?.message || result?.detail || result?.message;
    throw Object.assign(new Error(detail || `Sarvam ${mode} request failed (${response.status}).`), { status:response.status === 429 ? 429 : 502 });
  }
  return result;
}

function supabaseHeaders(extra = {}) {
  return { apikey:SUPABASE_KEY, Authorization:`Bearer ${SUPABASE_KEY}`, ...extra };
}

async function supabaseRequest(endpoint, options = {}) {
  requireSupabase();
  const response = await fetch(`${SUPABASE_URL}${endpoint}`, {
    ...options, headers:supabaseHeaders(options.headers || {}), signal:AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw Object.assign(new Error(detail.message || detail.error || detail.hint || `Supabase request failed (${response.status}).`), { status:502 });
  }
  return response;
}

function safeAudioExtension(file) {
  return ({ "audio/webm":".webm", "video/webm":".webm", "audio/wav":".wav", "audio/x-wav":".wav", "audio/mpeg":".mp3", "audio/mp4":".m4a", "audio/ogg":".ogg" })[baseMimeType(file.type)]
    || path.extname(file.filename).slice(0,8) || ".audio";
}

async function uploadAudio(file, objectPath) {
  await supabaseRequest(`/storage/v1/object/${encodeURIComponent(STORAGE_BUCKET)}/${objectPath.split("/").map(encodeURIComponent).join("/")}`, {
    method:"POST", headers:{ "Content-Type":baseMimeType(file.type), "x-upsert":"false" }, body:file.content
  });
}

async function removeAudio(objectPath) {
  try {
    await supabaseRequest(`/storage/v1/object/${encodeURIComponent(STORAGE_BUCKET)}`, {
      method:"DELETE", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ prefixes:[objectPath] })
    });
  } catch (error) { console.error("Could not roll back audio upload", error); }
}

async function insertSubmission(record) {
  const response = await supabaseRequest("/rest/v1/field_feedback", {
    method:"POST", headers:{ "Content-Type":"application/json", Prefer:"return=representation" }, body:JSON.stringify(record)
  });
  return (await response.json())[0];
}

async function handleSubmit(req, res) {
  const { fields, file } = parseMultipart(await readBody(req), req.headers["content-type"] || "");
  validateSubmission(fields, file);
  requireSupabase();
  const [original, english] = await Promise.all([
    sarvamSpeechToText(file, fields.languageCode, "transcribe"),
    sarvamSpeechToText(file, fields.languageCode, "translate")
  ]);
  const id = crypto.randomUUID();
  const objectPath = `${fields.eventDate}/${id}${safeAudioExtension(file)}`;
  await uploadAudio(file, objectPath);
  try {
    const feedback = await insertSubmission({
      id, event_date:fields.eventDate.trim(), event_name:fields.eventName.trim(), state:fields.state.trim(),
      school:fields.school.trim(), context:fields.context?.trim() || "", transcript:original.transcript || "",
      english_translation:english.transcript || "", language_code:original.language_code || english.language_code || fields.languageCode || "unknown",
      sarvam_transcription_id:original.request_id || null, sarvam_translation_id:english.request_id || null,
      audio_path:objectPath, audio_mime_type:baseMimeType(file.type), audio_size_bytes:file.content.length
    });
    sendJson(res, 201, { success:true, feedback:{ id:feedback.id, transcript:feedback.transcript, englishTranslation:feedback.english_translation, languageCode:feedback.language_code } });
  } catch (error) { await removeAudio(objectPath); throw error; }
}

function verifyDashboard(req) {
  const required = process.env.DASHBOARD_PASSCODE;
  if (required && req.headers["x-dashboard-passcode"] !== required) throw Object.assign(new Error("Dashboard passcode is incorrect."), { status:401 });
}

async function handleList(req, res) {
  verifyDashboard(req);
  const response = await supabaseRequest("/rest/v1/field_feedback?select=*&order=created_at.desc&limit=500", { method:"GET" });
  const rows = await response.json();
  sendJson(res, 200, { submissions:rows.map(row => ({
    id:row.id, eventDate:row.event_date, eventName:row.event_name, state:row.state, school:row.school,
    context:row.context, transcript:row.transcript, englishTranslation:row.english_translation,
    languageCode:row.language_code, createdAt:row.created_at, audioSizeBytes:row.audio_size_bytes,
    audioUrl:`/api/submissions/${row.id}/audio`
  })) });
}

async function getSubmission(id, select = "*") {
  const response = await supabaseRequest(`/rest/v1/field_feedback?id=eq.${encodeURIComponent(id)}&select=${encodeURIComponent(select)}&limit=1`, { method:"GET" });
  return (await response.json())[0];
}

async function handleAudio(req, res, id) {
  verifyDashboard(req);
  const row = await getSubmission(id, "audio_path,audio_mime_type");
  if (!row) throw Object.assign(new Error("Submission not found."), { status:404 });
  const response = await supabaseRequest(`/storage/v1/object/authenticated/${encodeURIComponent(STORAGE_BUCKET)}/${row.audio_path.split("/").map(encodeURIComponent).join("/")}`, { method:"GET" });
  const audio = Buffer.from(await response.arrayBuffer());
  res.writeHead(200, { "Content-Type":row.audio_mime_type || "audio/webm", "Content-Length":audio.length, "Cache-Control":"private, max-age=300" });
  res.end(audio);
}

async function handleTts(req, res) {
  verifyDashboard(req);
  requireSarvam();
  const { id, speaker = "shubh" } = await readJson(req);
  const row = await getSubmission(id, "english_translation");
  if (!row) throw Object.assign(new Error("Submission not found."), { status:404 });
  if (!row.english_translation) throw Object.assign(new Error("This submission has no English translation."), { status:400 });
  const response = await fetch("https://api.sarvam.ai/text-to-speech", {
    method:"POST", headers:{ "api-subscription-key":process.env.SARVAM_API_KEY, "Content-Type":"application/json" },
    body:JSON.stringify({ text:row.english_translation.slice(0,2500), target_language_code:"en-IN", model:"bulbul:v3", speaker, pace:1.0, speech_sample_rate:24000 }),
    signal:AbortSignal.timeout(60000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.audios?.length) throw Object.assign(new Error(result?.error?.message || result?.detail || "English speech generation failed."), { status:502 });
  const audio = Buffer.from(result.audios.join(""), "base64");
  res.writeHead(200, { "Content-Type":"audio/wav", "Content-Length":audio.length, "Cache-Control":"no-store" });
  res.end(audio);
}

function serveStatic(req, res) {
  const requestPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error:"Forbidden" });
  fs.readFile(filePath, (error, data) => {
    if (error) return sendJson(res, 404, { error:"Not found" });
    res.writeHead(200, { "Content-Type":MIME_TYPES[path.extname(filePath)] || "application/octet-stream", "Cache-Control":"no-cache" }); res.end(data);
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/feedback") return await handleSubmit(req, res);
    if (req.method === "GET" && url.pathname === "/api/submissions") return await handleList(req, res);
    if (req.method === "POST" && url.pathname === "/api/tts") return await handleTts(req, res);
    const audioMatch = req.method === "GET" && url.pathname.match(/^\/api\/submissions\/([0-9a-f-]+)\/audio$/i);
    if (audioMatch) return await handleAudio(req, res, audioMatch[1]);
    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 405, { error:"Method not allowed" });
  } catch (error) { sendError(res, error); }
}).listen(PORT, () => console.log(`VE Speak is ready at http://localhost:${PORT}`));
