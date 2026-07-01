const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadEnv(path.join(__dirname, ".env"));
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const FEEDBACK_FILE = path.join(DATA_DIR, "feedback.json");
const MAX_BODY_BYTES = 15 * 1024 * 1024;
fs.mkdirSync(AUDIO_DIR, { recursive: true });
if (!fs.existsSync(FEEDBACK_FILE)) fs.writeFileSync(FEEDBACK_FILE, "[]\n");

const MIME_TYPES = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"application/javascript; charset=utf-8", ".svg":"image/svg+xml", ".png":"image/png" };

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type":"application/json; charset=utf-8", "Content-Length":Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error("Audio is too large. Please keep it under 15 MB."), { status:413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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

function validate(fields, file) {
  for (const key of ["eventDate","eventName","state","school"]) if (!fields[key]?.trim()) throw Object.assign(new Error("Please complete all event and school details."), { status:400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.eventDate)) throw Object.assign(new Error("Please provide a valid event date."), { status:400 });
  if (!file?.content?.length) throw Object.assign(new Error("Please record or choose an audio file."), { status:400 });
  if (!file.type.startsWith("audio/") && file.type !== "video/webm") throw Object.assign(new Error("The uploaded file must be audio."), { status:400 });
}

async function transcribe(file, languageCode) {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw Object.assign(new Error("Sarvam API is not configured. Add SARVAM_API_KEY to the server .env file."), { status:503 });
  const form = new FormData();
  form.append("file", new Blob([file.content], { type:file.type }), file.filename);
  form.append("model", "saaras:v3"); form.append("mode", "transcribe"); form.append("language_code", languageCode || "unknown");
  const response = await fetch("https://api.sarvam.ai/speech-to-text", { method:"POST", headers:{ "api-subscription-key":key }, body:form, signal:AbortSignal.timeout(45000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = result?.error?.message || result?.detail || result?.message;
    throw Object.assign(new Error(detail || `Sarvam transcription failed (${response.status}).`), { status:response.status === 429 ? 429 : 502 });
  }
  return result;
}

async function saveFeedback(fields, file, result) {
  const id = crypto.randomUUID();
  const ext = ({ "audio/webm":".webm", "video/webm":".webm", "audio/wav":".wav", "audio/x-wav":".wav", "audio/mpeg":".mp3", "audio/mp4":".m4a", "audio/ogg":".ogg" })[file.type] || path.extname(file.filename).slice(0,8) || ".audio";
  const audioName = `${id}${ext}`;
  await fs.promises.writeFile(path.join(AUDIO_DIR, audioName), file.content);
  const entry = { id, eventDate:fields.eventDate.trim(), eventName:fields.eventName.trim(), state:fields.state.trim(), school:fields.school.trim(), context:fields.context?.trim() || "", transcript:result.transcript || "", languageCode:result.language_code || fields.languageCode || "unknown", sarvamRequestId:result.request_id || null, audioFile:`data/audio/${audioName}`, createdAt:new Date().toISOString() };
  const records = JSON.parse(await fs.promises.readFile(FEEDBACK_FILE, "utf8"));
  records.unshift(entry); await fs.promises.writeFile(FEEDBACK_FILE, `${JSON.stringify(records, null, 2)}\n`);
  return entry;
}

async function handleSubmit(req, res) {
  const { fields, file } = parseMultipart(await readBody(req), req.headers["content-type"] || "");
  validate(fields, file);
  const result = await transcribe(file, fields.languageCode);
  sendJson(res, 201, { success:true, feedback:await saveFeedback(fields, file, result) });
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
    if (req.method === "POST" && req.url === "/api/feedback") return await handleSubmit(req, res);
    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 405, { error:"Method not allowed" });
  } catch (error) { console.error(error); if (!res.headersSent) sendJson(res, error.status || 500, { error:error.message || "Something went wrong." }); }
}).listen(PORT, () => console.log(`VE Speak is ready at http://localhost:${PORT}`));
