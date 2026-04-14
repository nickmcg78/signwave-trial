import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Base64url decode for JWT parsing
function base64UrlDecode(input: string): Uint8Array {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Standard base64 decode (for image header parsing)
function base64DecodeToBytes(b64: string): Uint8Array {
  let clean = b64;
  while (clean.length % 4 !== 0) clean += "=";
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Safe base64 encoding for large binary data
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  let result = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    result += String.fromCharCode(...chunk);
  }
  return btoa(result);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function detectMimeFromBase64(b64: string): string {
  try {
    const raw = base64DecodeToBytes(b64.slice(0, 32));
    if (raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47) return "image/png";
    if (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) return "image/jpeg";
    if (
      raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46 &&
      raw[8] === 0x57 && raw[9] === 0x45 && raw[10] === 0x42 && raw[11] === 0x50
    ) return "image/webp";
    if (raw[0] === 0x47 && raw[1] === 0x49 && raw[2] === 0x46) return "image/gif";
  } catch { /* fallback */ }
  return "image/jpeg";
}

function getImageDimensions(b64: string): { width: number; height: number } | null {
  try {
    const raw = base64DecodeToBytes(b64.slice(0, 2048));
    if (raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47) {
      const width = (raw[16] << 24) | (raw[17] << 16) | (raw[18] << 8) | raw[19];
      const height = (raw[20] << 24) | (raw[21] << 16) | (raw[22] << 8) | raw[23];
      if (width > 0 && height > 0) return { width, height };
    }
    if (raw[0] === 0xff && raw[1] === 0xd8) {
      let offset = 2;
      while (offset < raw.length - 9) {
        if (raw[offset] !== 0xff) { offset++; continue; }
        const marker = raw[offset + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          const height = (raw[offset + 5] << 8) | raw[offset + 6];
          const width = (raw[offset + 7] << 8) | raw[offset + 8];
          if (width > 0 && height > 0) return { width, height };
        }
        const segLen = (raw[offset + 2] << 8) | raw[offset + 3];
        offset += 2 + segLen;
      }
    }
  } catch { /* fallback */ }
  return null;
}

function aspectRatio(w: number, h: number): number { return w / h; }

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 5;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) return false;
  entry.count++;
  return true;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0") return false;
    const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      if (a === 10) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      if (a === 169 && b === 254) return false;
    }
    if (hostname === "metadata.google.internal" || hostname.endsWith(".internal") || hostname.includes("metadata")) return false;
    return true;
  } catch { return false; }
}

function validateDataUrl(dataUrl: string, maxSizeMB: number = 10): { valid: boolean; error?: string } {
  if (!dataUrl.startsWith("data:")) return { valid: false, error: "Invalid data URL format" };
  const base64Match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!base64Match) return { valid: false, error: "Invalid data URL format" };
  const mimeType = base64Match[1];
  const base64Data = base64Match[2];
  if (!mimeType.startsWith("image/")) return { valid: false, error: "Only image data URLs are allowed" };
  const approximateSizeBytes = (base64Data.length * 3) / 4;
  if (approximateSizeBytes > maxSizeMB * 1024 * 1024) return { valid: false, error: `Image size exceeds ${maxSizeMB}MB limit` };
  return { valid: true };
}

function validateString(value: unknown, fieldName: string, maxLength: number, required: boolean = false): { valid: boolean; value: string; error?: string } {
  if (value === undefined || value === null || value === "") {
    if (required) return { valid: false, value: "", error: `${fieldName} is required` };
    return { valid: true, value: "" };
  }
  if (typeof value !== "string") return { valid: false, value: "", error: `${fieldName} must be a string` };
  const trimmed = value.trim();
  if (trimmed.length > maxLength) return { valid: false, value: "", error: `${fieldName} must be less than ${maxLength} characters` };
  const sanitized = trimmed.replace(/[\x00-\x1F\x7F]/g, "");
  return { valid: true, value: sanitized };
}

function validateImageUrl(url: unknown, fieldName: string, required: boolean = false): { valid: boolean; value: string; error?: string } {
  if (url === undefined || url === null || url === "") {
    if (required) return { valid: false, value: "", error: `${fieldName} is required` };
    return { valid: true, value: "" };
  }
  if (typeof url !== "string") return { valid: false, value: "", error: `${fieldName} must be a string` };
  const trimmed = url.trim();
  if (trimmed.startsWith("data:")) {
    const dataUrlValidation = validateDataUrl(trimmed);
    if (!dataUrlValidation.valid) return { valid: false, value: "", error: dataUrlValidation.error };
    return { valid: true, value: trimmed };
  }
  if (!isValidUrl(trimmed)) return { valid: false, value: "", error: `${fieldName} must be a valid public URL` };
  return { valid: true, value: trimmed };
}

const ASPECT_RATIO_TOLERANCE = 0.30;
const MAX_GENERATION_ATTEMPTS = 4;

function parseVisionBoolean(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes";
  }
  return false;
}

function aspectRatiosMatch(sourceAR: number, generatedAR: number): { match: boolean; delta: number } {
  const delta = Math.abs(sourceAR - generatedAR) / sourceAR;
  return { match: delta <= ASPECT_RATIO_TOLERANCE, delta };
}

interface VisionEdgeResult {
  pass: boolean;
  topEdgeMatch: boolean;
  bottomEdgeMatch: boolean;
  leftEdgeMatch: boolean;
  rightEdgeMatch: boolean;
  reason: string;
}

function buildEdgeRepairDirective(result: VisionEdgeResult | null): string {
  if (!result) return "";
  const missingEdges: string[] = [];
  if (!result.topEdgeMatch) missingEdges.push("TOP");
  if (!result.bottomEdgeMatch) missingEdges.push("BOTTOM");
  if (!result.leftEdgeMatch) missingEdges.push("LEFT");
  if (!result.rightEdgeMatch) missingEdges.push("RIGHT");
  if (missingEdges.length === 0) return "";
  return ` EDGE-REPAIR TARGET: The previous output lost content at edge(s): ${missingEdges.join(", ")}. Keep those edges identical to the source and preserve every boundary object in place.`;
}

async function verifyFramingWithVision(
  sourceBase64: string, sourceMime: string,
  generatedBase64: string, generatedMime: string,
  lovableApiKey: string, modelName: string = "google/gemini-2.5-flash",
): Promise<VisionEdgeResult> {
  const FAIL: VisionEdgeResult = { pass: false, topEdgeMatch: false, bottomEdgeMatch: false, leftEdgeMatch: false, rightEdgeMatch: false, reason: "" };
  try {
    const verifyResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${lovableApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName, temperature: 0,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `You are a strict framing-consistency judge.\nCompare IMAGE 1 (source) vs IMAGE 2 (AI-edited output).\n\nTask: decide whether IMAGE 2 preserves IMAGE 1 framing exactly (no zoom/crop/reframe).\n\nCRITICAL EVALUATION METHOD:\n- Evaluate only geometric framing and boundary content.\n- Focus on the OUTERMOST border strips (about 2-3% of each edge).\n- Ignore color grading, texture/style changes, sign artwork changes, and resolution differences.\n- If IMAGE 2 is higher resolution but shows the same boundary content, that can still be a match.\n\nEdge checks:\n- topEdgeMatch: top boundary shows same roofline/sky objects.\n- bottomEdgeMatch: bottom boundary shows same ground/pavement objects.\n- leftEdgeMatch: left boundary shows same side-building/street objects.\n- rightEdgeMatch: right boundary shows same side-building/street objects.\n\nFail conditions:\n- Any edge shows less scene content than IMAGE 1 (zoom/crop).\n- Camera framing shifts/pans/reframes.\n\nReturn exactly one JSON object and nothing else:\n{"pass":true/false,"topEdgeMatch":true/false,"bottomEdgeMatch":true/false,"leftEdgeMatch":true/false,"rightEdgeMatch":true/false,"reason":"brief explanation"}` },
            { type: "image_url", image_url: { url: `data:${sourceMime};base64,${sourceBase64}` } },
            { type: "image_url", image_url: { url: `data:${generatedMime};base64,${generatedBase64}` } },
          ],
        }],
      }),
    });
    if (!verifyResponse.ok) { console.error("Vision verification API error (advisory):", verifyResponse.status); return { ...FAIL, reason: `vision_api_error_${verifyResponse.status}` }; }
    const verifyData = await verifyResponse.json();
    const text = verifyData.choices?.[0]?.message?.content?.trim() || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ...FAIL, reason: "unparseable_response" };
    const parsed = JSON.parse(jsonMatch[0]);
    const top = parseVisionBoolean(parsed.topEdgeMatch);
    const bottom = parseVisionBoolean(parsed.bottomEdgeMatch);
    const left = parseVisionBoolean(parsed.leftEdgeMatch);
    const right = parseVisionBoolean(parsed.rightEdgeMatch);
    const overallPass = top && bottom && left && right;
    return { pass: overallPass, topEdgeMatch: top, bottomEdgeMatch: bottom, leftEdgeMatch: left, rightEdgeMatch: right, reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : overallPass ? "all_edges_match" : "edge_mismatch" };
  } catch (e) { console.error("Vision verification exception (advisory):", e); return { ...FAIL, reason: "vision_exception" }; }
}

async function fetchImageAsBase64(url: string): Promise<{ base64: string; mime: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { Accept: "image/*" } });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const buf = await blob.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    const mime = blob.type || detectMimeFromBase64(b64);
    return { base64: b64, mime };
  } catch (e) { clearTimeout(timeoutId); throw e; }
}

// --- PNG mask generation utilities ---
// Deno edge functions don't have a canvas library, so we build the PNG binary
// from scratch. A mask is a simple image: opaque black (protected) with a
// transparent rectangle (the fascia zone OpenAI is allowed to edit).

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ PNG_CRC_TABLE[(crc ^ data[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const buf = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, data.length);
  buf.set(typeBytes, 4);
  buf.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  view.setUint32(8 + data.length, pngCrc32(crcInput));
  return buf;
}

async function compressZlib(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  const readAll = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();
  await writer.write(data);
  await writer.close();
  await readAll;
  let len = 0;
  for (const c of chunks) len += c.length;
  const result = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { result.set(c, off); off += c.length; }
  return result;
}

async function generateMaskPNG(
  width: number, height: number,
  topPx: number, bottomPx: number, leftPx: number, rightPx: number,
): Promise<Uint8Array> {
  const rowLen = 1 + width * 4; // filter byte + RGBA

  // Pre-build two row templates instead of per-pixel branching
  const opaqueRow = new Uint8Array(rowLen); // all opaque black
  opaqueRow[0] = 0; // PNG filter: None
  for (let x = 0; x < width; x++) opaqueRow[1 + x * 4 + 3] = 255;

  const zoneRow = new Uint8Array(rowLen); // white in fascia zone (fal.ai: white=inpaint)
  zoneRow[0] = 0;
  for (let x = 0; x < width; x++) {
    if (x >= leftPx && x < rightPx) {
      zoneRow[1 + x * 4] = 255;     // R
      zoneRow[1 + x * 4 + 1] = 255; // G
      zoneRow[1 + x * 4 + 2] = 255; // B
    }
    zoneRow[1 + x * 4 + 3] = 255;   // A (always opaque)
  }

  // Assemble raw scanlines
  const raw = new Uint8Array(height * rowLen);
  for (let y = 0; y < height; y++) {
    raw.set((y >= topPx && y < bottomPx) ? zoneRow : opaqueRow, y * rowLen);
  }

  // Compress with zlib (CompressionStream 'deflate' produces RFC 1950 zlib format)
  const compressed = await compressZlib(raw);

  // Build PNG file: signature + IHDR + IDAT + IEND
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type: RGBA
  const ihdr = pngChunk('IHDR', ihdrData);
  const idat = pngChunk('IDAT', compressed);
  const iend = pngChunk('IEND', new Uint8Array(0));

  const png = new Uint8Array(sig.length + ihdr.length + idat.length + iend.length);
  let off = 0;
  png.set(sig, off); off += sig.length;
  png.set(ihdr, off); off += ihdr.length;
  png.set(idat, off); off += idat.length;
  png.set(iend, off);
  return png;
}

// --- Fascia zone detection via Gemini ---

interface FasciaZone {
  topPercent: number;
  bottomPercent: number;
  leftPercent: number;
  rightPercent: number;
  confidence: string;
  notes: string;
}

async function detectFasciaZone(
  imageBase64: string, imageMime: string, geminiApiKey: string,
): Promise<FasciaZone | null> {
  try {
    // Call Google Gemini API directly (not via Lovable gateway)
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: `Look at this building photo. Identify the fascia band — the horizontal zone between the top of the windows/door openings and the roofline or parapet edge.

Return ONLY a JSON object with these fields, no other text:
{
  "top_percent": <number 0-100, where 0 is top of image>,
  "bottom_percent": <number 0-100>,
  "left_percent": <number 0-100, where 0 is left edge>,
  "right_percent": <number 0-100>,
  "confidence": "high" | "medium" | "low",
  "notes": "<brief description of what you found>"
}

If there is no clear fascia band, return top_percent: 5, bottom_percent: 25 as a default.`,
              },
              { inline_data: { mime_type: imageMime, data: imageBase64 } },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
      },
    );
    if (!response.ok) {
      const errBody = await response.text();
      console.warn(`[mask] Gemini fascia detection API error: ${response.status}`, errBody);
      return null;
    }
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[mask] Gemini fascia detection: could not parse JSON from response");
      return null;
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      topPercent: typeof parsed.top_percent === "number" ? parsed.top_percent : 5,
      bottomPercent: typeof parsed.bottom_percent === "number" ? parsed.bottom_percent : 25,
      leftPercent: typeof parsed.left_percent === "number" ? parsed.left_percent : 0,
      rightPercent: typeof parsed.right_percent === "number" ? parsed.right_percent : 100,
      confidence: typeof parsed.confidence === "string" ? parsed.confidence : "low",
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
    };
  } catch (e) {
    console.warn("[mask] Gemini fascia detection exception:", e);
    return null;
  }
}

const DEFAULT_FASCIA_ZONE: FasciaZone = {
  topPercent: 0, bottomPercent: 15, leftPercent: 0, rightPercent: 100,
  confidence: "default", notes: "default top-band fallback",
};

function getSupabaseAdmin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401 });
    }

    const supabaseAdmin = getSupabaseAdmin();
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid authentication token" }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401 });
    }

    const clientIP = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
    if (!checkRateLimit(clientIP)) {
      return new Response(JSON.stringify({ error: "Too many requests. Please try again later." }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 429 });
    }

    const body = await req.json();

    const shopImageValidation = validateImageUrl(body.shopImageUrl, "Shop image", true);
    if (!shopImageValidation.valid) return new Response(JSON.stringify({ error: shopImageValidation.error }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 });
    const shopImageUrl = shopImageValidation.value;

    const logoValidation = validateImageUrl(body.logoUrl, "Logo");
    if (!logoValidation.valid) return new Response(JSON.stringify({ error: logoValidation.error }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 });
    const logoUrl = logoValidation.value;

    const taglineValidation = validateString(body.tagline, "Tagline", 200);
    const tagline = taglineValidation.valid ? taglineValidation.value : "";

    const sizeValidation = validateString(body.size, "Size", 50);
    const size = sizeValidation.valid ? sizeValidation.value : "medium";

    const finishValidation = validateString(body.finish, "Finish", 50);
    const finish = finishValidation.valid ? finishValidation.value : "standard";

    const illuminationValidation = validateString(body.illumination, "Illumination", 50);
    const illumination = illuminationValidation.valid ? illuminationValidation.value : "standard";

    const timeOfDayValidation = validateString(body.timeOfDay, "Time of day", 20);
    const timeOfDay = timeOfDayValidation.valid ? timeOfDayValidation.value : "day";

    interface SignInput { signType: string; signPosition: string; replaceExisting: boolean; existingSignDescription: string; contactDetails: string; }
    let signs: SignInput[] = [];

    if (Array.isArray(body.signs) && body.signs.length > 0) {
      for (const s of body.signs) {
        const stv = validateString(s.signType, "Sign type", 100, true);
        if (!stv.valid) return new Response(JSON.stringify({ error: stv.error }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 });
        const spv = validateString(s.signPosition, "Sign position", 2000);
        const esdv = validateString(s.existingSignDescription, "Existing sign description", 300);
        const cdv = validateString(s.contactDetails, "Contact details", 200);
        signs.push({ signType: stv.value, signPosition: spv.valid ? spv.value : "", replaceExisting: s.replaceExisting === true, existingSignDescription: esdv.valid ? esdv.value : "", contactDetails: cdv.valid ? cdv.value : "" });
      }
    } else {
      const signTypeValidation = validateString(body.signType, "Sign type", 100, true);
      if (!signTypeValidation.valid) return new Response(JSON.stringify({ error: signTypeValidation.error }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 });
      const signPositionValidation = validateString(body.signPosition, "Sign position", 2000);
      const existingSignDescValidation = validateString(body.existingSignDescription, "Existing sign description", 300);
      const contactDetailsValidation = validateString(body.contactDetails, "Contact details", 200);
      signs.push({ signType: signTypeValidation.value, signPosition: signPositionValidation.valid ? signPositionValidation.value : "", replaceExisting: body.replaceExisting === true, existingSignDescription: existingSignDescValidation.valid ? existingSignDescValidation.value : "", contactDetails: contactDetailsValidation.valid ? contactDetailsValidation.value : "" });
    }

    console.log(`[generate-mockup] ${signs.length} sign(s) requested`);

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) return new Response(JSON.stringify({ error: "OpenAI API key not configured" }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 });

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

    const { data: jobData, error: jobError } = await supabaseAdmin
      .from("mockup_jobs")
      .insert({ status: "pending", progress: `Processing 0/${signs.length} signs...` })
      .select("id")
      .single();

    if (jobError || !jobData) {
      console.error("[generate-mockup] Failed to create job:", jobError);
      return new Response(JSON.stringify({ error: "Failed to create generation job" }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 });
    }

    const jobId = jobData.id;
    console.log(`[generate-mockup] Created job ${jobId}`);

    const backgroundWork = (async () => {
      try {
        await supabaseAdmin.from("mockup_jobs").update({ status: "processing", progress: `Preparing images...`, updated_at: new Date().toISOString() }).eq("id", jobId);

        let shopImageBase64: string;
        let shopMime: string;

        if (shopImageUrl.startsWith("data:")) {
          const mimeMatch = shopImageUrl.match(/^data:([^;]+);base64,(.+)$/);
          shopMime = mimeMatch?.[1] || "image/jpeg";
          shopImageBase64 = mimeMatch?.[2] || shopImageUrl.split(",")[1];
        } else {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);
          try {
            const shopImageResponse = await fetch(shopImageUrl, { signal: controller.signal, headers: { Accept: "image/*" } });
            clearTimeout(timeoutId);
            const contentLength = shopImageResponse.headers.get("content-length");
            if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) throw new Error("Shop image exceeds 10MB limit");
            const shopImageBlob = await shopImageResponse.blob();
            if (!shopImageBlob.type.startsWith("image/")) throw new Error("Shop image URL must point to an image file");
            const shopImageBuffer = await shopImageBlob.arrayBuffer();
            shopImageBase64 = arrayBufferToBase64(shopImageBuffer);
            shopMime = shopImageBlob.type || detectMimeFromBase64(shopImageBase64);
          } catch (fetchError: unknown) { clearTimeout(timeoutId); throw fetchError; }
        }

        const sourceDims = getImageDimensions(shopImageBase64);
        const sourceAR = sourceDims ? aspectRatio(sourceDims.width, sourceDims.height) : null;
        console.log(`[generate-mockup] Source: ${sourceDims?.width}x${sourceDims?.height}, AR=${sourceAR?.toFixed(4)}, MIME=${shopMime}`);

        let logoBase64: string | null = null;
        let logoMime: string = "image/png";

        if (logoUrl) {
          if (logoUrl.startsWith("data:")) {
            const mimeMatch = logoUrl.match(/^data:([^;]+);base64,(.+)$/);
            logoMime = mimeMatch?.[1] || "image/png";
            logoBase64 = mimeMatch?.[2] || logoUrl.split(",")[1];
          } else {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            try {
              const logoResponse = await fetch(logoUrl, { signal: controller.signal, headers: { Accept: "image/*" } });
              clearTimeout(timeoutId);
              const contentLength = logoResponse.headers.get("content-length");
              if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) throw new Error("Logo exceeds 5MB limit");
              const logoBlob = await logoResponse.blob();
              if (!logoBlob.type.startsWith("image/")) throw new Error("Logo URL must point to an image file");
              const logoBuffer = await logoBlob.arrayBuffer();
              logoBase64 = arrayBufferToBase64(logoBuffer);
              logoMime = logoBlob.type || detectMimeFromBase64(logoBase64);
            } catch (fetchError: unknown) { clearTimeout(timeoutId); throw fetchError; }
          }
        }

        const styleDescriptions: Record<string, string> = {
          "window-perf": "One-Way Vision vinyl (perforated window film) applied directly onto the glass surface. The graphic is SEMI-TRANSPARENT — the shop interior must remain partially visible through the vinyl. This is NOT a solid panel or physical sign. Zero depth, zero standoff. The glass surface and window frame remain unchanged.",
          "blade-sign": "This sign PROJECTS OUTWARD from the building wall at 90 degrees, perpendicular to the facade, hanging from a metal bracket arm.",
          "3d-letters": "Individual dimensional CHANNEL LETTERS mounted to the wall with stand-off pins. Each letter casts its own shadow.",
          lightbox: "Illuminated LIGHTBOX CABINET sign — enclosed, backlit panel with 3-inch aluminium frame depth.",
          "fascia-panel": "FASCIA-MOUNTED flat panel sign applied directly to the building's header/fascia board.",
        };
        const finishDescriptions: Record<string, string> = {
          gloss: "High-sheen acrylic face with sharp, mirror-like environmental reflections.",
          metallic: "Brushed aluminium frame with anisotropic highlights and visible 50mm depth.",
          matte: "Powder-coated, non-reflective surface that absorbs ambient light evenly.",
          standard: "Standard painted surface with subtle environmental light interaction.",
        };
        const sizeDescriptions: Record<string, string> = {
          small: "Discrete plaque, approximately 600mm wide.",
          medium: "Mid-sized commercial sign, proportioned to the storefront fascia.",
          large: "Major architectural fascia sign spanning the available wall width.",
        };

        const sigwaveStyleGuide = `
SIGNWAVE INSTALLATION STYLE (CRITICAL):
You are producing a visualisation in the style of Signwave Australia — a professional sign franchise known for:
• Clean, high-contrast, professionally executed exterior signage
• Strong dimensional lettering on facades as a signature style
• Bold, graphic window vinyl treatments (not subtle)
• Illuminated fascia signs with polished aluminium surrounds
• Australian strip-shopping and commercial retail context
• Signs that look physically manufactured and installed — not digital overlays
Every sign must look like it was fabricated by a professional sign company and physically installed on the building.

PHYSICAL REALISM (CRITICAL — DO NOT IGNORE):
The sign must appear physically manufactured and installed — not digitally composited or overlaid.
Every generated sign must have ALL of the following:
• The sign casts a natural shadow on the wall surface behind it, consistent with the ambient light direction in the photograph
• Mounting hardware is visible — screw fixings, standoffs, or aluminium extrusion edges at the perimeter of the sign
• The sign surface has appropriate material texture — brushed aluminium, matte acrylic, painted steel — not a flat graphic
• The perspective and foreshortening of the sign exactly matches the camera angle and lens distortion of the original photograph
• The sign sits flush against the building surface or within a recessed channel — it does not float, hover, or appear pasted on
• Lighting on the sign face is consistent with the light source and time of day visible in the photograph

PLACEMENT CONSTRAINTS (CRITICAL):
• Fascia signs within the existing fascia band ONLY — do not create, manufacture, or invent any new fascia panel, lightbox cabinet, sign surround, or architectural structure that does not physically exist in the original photograph
• The fascia material, colour, depth, and profile must remain identical to the original — only the surface graphics change
• Signs must NEVER overlap windows, glazing, roller doors, garage doors, or any architectural opening
• Signs must NEVER overlap structural columns, pillars, or downpipes
• Scale sign DOWN to fit — never expand fascia height or width
• Place exactly ONE sign per instruction — no duplicates on secondary walls or upper floors`;

        let currentShopBase64 = shopImageBase64;
        let currentShopMime = shopMime;

        // --- Detect fascia zone for masking (optional for Flux Kontext Lora Inpaint) ---
        let fasciaZone: FasciaZone;
        if (GEMINI_API_KEY) {
          await supabaseAdmin.from("mockup_jobs").update({ progress: "Detecting fascia zone...", updated_at: new Date().toISOString() }).eq("id", jobId);
          const detected = await detectFasciaZone(shopImageBase64, shopMime, GEMINI_API_KEY);
          if (detected && detected.confidence !== "low") {
            console.log(`[mask] Gemini detected fascia zone: top=${detected.topPercent}% bottom=${detected.bottomPercent}% left=${detected.leftPercent}% right=${detected.rightPercent}% confidence=${detected.confidence}`);
            // Add 5% padding in each direction for breathing room
            fasciaZone = {
              topPercent: Math.max(0, detected.topPercent - 5),
              bottomPercent: Math.min(100, detected.bottomPercent + 5),
              leftPercent: Math.max(0, detected.leftPercent - 5),
              rightPercent: Math.min(100, detected.rightPercent + 5),
              confidence: detected.confidence,
              notes: detected.notes,
            };
            // Cap mask height to prevent over-masking (max 20% of image height)
            if (fasciaZone.bottomPercent - fasciaZone.topPercent > 20) {
              console.warn(`[mask] Capping mask height from ${(fasciaZone.bottomPercent - fasciaZone.topPercent).toFixed(1)}% to 20%`);
              fasciaZone.bottomPercent = fasciaZone.topPercent + 20;
            }
          } else {
            console.warn("[mask] Gemini detection failed, using default top-band mask");
            fasciaZone = { ...DEFAULT_FASCIA_ZONE };
          }
        } else {
          console.log("[mask] No GEMINI_API_KEY, using default top-band mask");
          fasciaZone = { ...DEFAULT_FASCIA_ZONE };
        }

        for (let signIndex = 0; signIndex < signs.length; signIndex++) {
          const s = signs[signIndex];
          const signLabel = `Sign ${signIndex + 1}/${signs.length}`;
          console.log(`[generate-mockup] ━━━ Starting ${signLabel} (${s.signType}) ━━━`);

          await supabaseAdmin.from("mockup_jobs").update({ progress: `Generating sign ${signIndex + 1} of ${signs.length}...`, updated_at: new Date().toISOString() }).eq("id", jobId);

          const iterDims = getImageDimensions(currentShopBase64);
          const iterAR = iterDims ? aspectRatio(iterDims.width, iterDims.height) : null;
          console.log(`[generate-mockup] ${signLabel} input: ${iterDims?.width}x${iterDims?.height}, AR=${iterAR?.toFixed(4)}`);

          const iterDimConstraint = iterDims
            ? `\nSOURCE IMAGE DIMENSIONS: ${iterDims.width}×${iterDims.height} pixels (aspect ratio ${iterAR!.toFixed(4)}). Output MUST match these exact dimensions and aspect ratio.`
            : "";

          let signSection = "";

          if (s.replaceExisting) {
            const sizingConstraint = `• SIZING CONSTRAINT (CRITICAL):\n  – The new sign MUST fit WITHIN the existing physical fascia band/structure dimensions.\n  – Do NOT enlarge, extend, or reshape any architectural element to accommodate the sign.\n  – The fascia height, width, and position must remain IDENTICAL to the original photograph.\n  – If the logo does not fit at full size, SCALE IT DOWN until it fits within the existing fascia boundary.\n  – Do NOT cover, obscure, or overlap any windows, doors, awnings, or other architectural features.\n  – The sign must sit entirely within the fascia band — never extend above, below, or beyond it.\n  – The building is IMMUTABLE — only the sign artwork changes, never the structure.\n`;
            signSection += s.existingSignDescription
              ? `SIGN REPLACEMENT DIRECTIVE:\n• LOCATE: Find the existing sign described as: "${s.existingSignDescription}".\n• ERASE: Paint over with the wall/surface texture behind it.\n• INSTALL: Place the NEW sign centered on the same position.\n${sizingConstraint}`
              : `SIGN REPLACEMENT DIRECTIVE:\n• LOCATE: Identify the most prominent existing signage.\n• ERASE: Paint over completely.\n• INSTALL: Place the NEW sign centered on the same position.\n${sizingConstraint}`;
          } else {
            signSection += `SIGN ADDITION DIRECTIVE:\n• Add the new sign at the specified position. Do NOT remove or modify any existing signage.\n`;
          }

          const styleKey = Object.keys(styleDescriptions).includes(s.signType) ? s.signType : "fascia-panel";
          signSection += `Type: ${s.signType}\nStyle: ${styleDescriptions[styleKey]}\n`;

          if (s.signPosition) { signSection += `Position: ${s.signPosition}\n`; }

          let signPrompt = `PERSONA: You are a professional sign production engineer with expertise in architectural visualisation. Edit the uploaded shopfront photograph to add signage featuring the provided brand logo, so it looks like a physical, high-end installation integrated seamlessly into the storefront.
${sigwaveStyleGuide}

BASE-PLATE LOCK (ABSOLUTE RULE):
• The source photograph is an IMMUTABLE BASE PLATE.
• Copy the original scene EDGE-TO-EDGE first, pixel-for-pixel.
• Then edit ONLY the sign pixels on top of the copied base plate.
• If the composition, framing, zoom, or field of view changes AT ALL — the output is INVALID.
• Every element visible at the edges of the source must remain in the same position.
${iterDimConstraint}

TEXT FIDELITY (CRITICAL): Logo text must be perfectly sharp, correctly oriented, and fully legible. No pixel-bleeding or melting artefacts.

THE ZERO-ZOOM LOCK (MANDATORY):
• Output MUST show the ENTIRE original photograph — every pixel from edge to edge.
• Do NOT zoom in, crop, pan, or reframe under ANY circumstances.

SINGLE-PLACEMENT LOCK (CRITICAL):
• Place the sign in EXACTLY ONE location on the building — the primary ground-floor fascia.
• Do NOT duplicate, repeat, or echo the sign on any other surface.
• Do NOT place any signage on upper floors, secondary walls, side walls, awnings, or rooflines.
• ONE sign, ONE location, ONE fascia — no exceptions.

${signSection}`;

          if (tagline) { signPrompt += `\nTagline: Include the tagline "${tagline}" as part of the signage display.`; }
          if (s.contactDetails) { signPrompt += `\nCONTACT DETAILS: Include the following contact details on the sign: ${s.contactDetails}`; }
          if (logoBase64) { signPrompt += `\nLOGO: Reproduce the client's brand logo accurately on the sign — correct colours, correct proportions, legible text.`; }

          signPrompt += `\nPhysical Specifications: ${sizeDescriptions[size] || sizeDescriptions.medium} ${finishDescriptions[finish] || finishDescriptions.standard}`;

          if (illumination === "illuminated" && timeOfDay === "day") {
            signPrompt += `\nLighting: Internally lit but no visible bloom in daylight. Reduce luminance by 15-20%.`;
          } else if (illumination === "illuminated" && timeOfDay === "night") {
            signPrompt += `\nLighting: Sign is a light source. Render realistic LED illumination casting a colour wash.`;
          } else if (timeOfDay === "day") {
            signPrompt += `\nLighting: No internal lighting, lit by scene's natural light. Reduce luminance by 15-20%.`;
          } else {
            signPrompt += `\nLighting: No internal lighting. Time of Day: ${timeOfDay}.`;
          }

          signPrompt += `
RENDERING QUALITY: Match resolution, grain, and lighting of the background photo. Render consistent shadow direction, colour temperature, and surface material reflections.
AMBIENT OCCLUSION: Render soft contact shadows at mounting points. Use shadow colour temperature from the photo — never pure black.
BLACK LEVEL MATCHING: All dark tones must match the original photograph's black levels. Do NOT use pure #000000.

STRICT OUTPUT CONSTRAINT: Generate ONLY the single sign described in the specification above. Do NOT add any additional signage, window graphics, vinyl decals, diagonal stripes, brand patterns, or any other visual elements anywhere else on the building. Every part of the building not covered by the specified sign must remain exactly as it appears in the original photograph.

FINAL STRUCTURAL CHECK: The building architecture in this output must be identical to the input photograph. Any new box, panel, cabinet, cladding, or frame that was not present in the original photo is a generation failure. The sign sits ON the existing surface — it does not replace the surface.`;

          if (signIndex > 0) { signPrompt += `\n\nPREVIOUS SIGNS: The input image already contains ${signIndex} previously rendered sign(s). Do NOT remove, modify, or obscure them. Only add the new sign described above.`; }

          // Generate mask PNG for this sign (optional for inpainting)
          let maskBase64: string | null = null;
          if (iterDims) {
            const topPx = Math.round((fasciaZone.topPercent / 100) * iterDims.height);
            const bottomPx = Math.round((fasciaZone.bottomPercent / 100) * iterDims.height);
            const leftPx = Math.round((fasciaZone.leftPercent / 100) * iterDims.width);
            const rightPx = Math.round((fasciaZone.rightPercent / 100) * iterDims.width);
            try {
              const maskPng = await generateMaskPNG(iterDims.width, iterDims.height, topPx, bottomPx, leftPx, rightPx);
              maskBase64 = arrayBufferToBase64(maskPng.buffer);
              console.log(`[mask] Generated mask PNG: ${iterDims.width}x${iterDims.height}, white zone y=${topPx}px–${bottomPx}px x=${leftPx}px–${rightPx}px`);
            } catch (maskErr) {
              console.warn("[mask] Failed to generate mask PNG, continuing without mask:", maskErr);
            }
          } else {
            console.warn("[mask] Could not determine image dimensions, skipping mask");
          }

          let lastGeneratedBase64: string | null = null;
          let lastGeneratedMime: string = "image/png";
          let lastFailReason: string = "";
          let lastVisionResult: VisionEdgeResult | null = null;
          let signSucceeded = false;

          for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
            console.log(`[generate-mockup] ${signLabel} — Attempt ${attempt}/${MAX_GENERATION_ATTEMPTS}`);

            await supabaseAdmin.from("mockup_jobs").update({ progress: `Generating sign ${signIndex + 1} of ${signs.length} (attempt ${attempt})...`, updated_at: new Date().toISOString() }).eq("id", jobId);

            let attemptPrompt = signPrompt;
            if (attempt > 1) {
              const edgeInfo = lastVisionResult ? ` Edge failures: top=${!lastVisionResult.topEdgeMatch}, bottom=${!lastVisionResult.bottomEdgeMatch}, left=${!lastVisionResult.leftEdgeMatch}, right=${!lastVisionResult.rightEdgeMatch}.` : "";
              const repairDirective = buildEdgeRepairDirective(lastVisionResult);
              const isFinalAttempt = attempt === MAX_GENERATION_ATTEMPTS;
              attemptPrompt += `\n\n⚠️ REPAIR MODE (attempt ${attempt}): Previous generation FAILED framing integrity (${lastFailReason}).${edgeInfo}${repairDirective}${isFinalAttempt ? " FINAL ATTEMPT: absolute edge-lock required." : ""}`;
            }

            // Build OpenAI gpt-image-1 /v1/images/edits multipart request.
            // The API expects the image as a file upload (Blob), NOT a data URL,
            // so we decode the base64 into binary and wrap it in a Blob.
            const imageBytes = base64DecodeToBytes(currentShopBase64);
            const imageBlob = new Blob([imageBytes], { type: currentShopMime });
            const imageExt = currentShopMime === "image/png" ? "png" : "jpg";

            const formData = new FormData();
            formData.append("model", "dall-e-2");
            formData.append("image", imageBlob, `building.${imageExt}`);
            formData.append("prompt", attemptPrompt);
            formData.append("size", "1024x1024");
            formData.append("response_format", "b64_json");

            if (maskBase64) {
              const maskBytes = base64DecodeToBytes(maskBase64);
              const maskBlob = new Blob([maskBytes], { type: "image/png" });
              formData.append("mask", maskBlob, "mask.png");
            }

            console.log(`[generate-mockup] ${signLabel} Attempt ${attempt}: OpenAI dall-e-2 /v1/images/edits, mask=${!!maskBase64}, logo=${!!logoBase64}, AR=${iterAR?.toFixed(4)}`);

            const response = await fetch("https://api.openai.com/v1/images/edits", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
              },
              body: formData,
            });

            if (!response.ok) {
              const errorBody = await response.text();
              console.error(`[generate-mockup] ${signLabel} Attempt ${attempt} OpenAI API error: HTTP ${response.status}`, errorBody);
              if (response.status === 429) throw new Error("Too many AI requests. Please wait a moment and try again.");
              if (response.status === 401 || response.status === 403) {
                console.error(`[generate-mockup] OpenAI auth failed. Key prefix: ${OPENAI_API_KEY?.substring(0, 8)}...`);
                throw new Error("OpenAI API key invalid or not configured correctly.");
              }
              if (response.status === 400) {
                console.error(`[generate-mockup] OpenAI validation error:`, errorBody);
                throw new Error("The AI could not process the provided image. Please try a different photo or re-upload.");
              }
              if (attempt < MAX_GENERATION_ATTEMPTS) { lastFailReason = `api_error_${response.status}`; continue; }
              throw new Error(`Sign ${signIndex + 1} could not be generated. Please try again.`);
            }

            const data = await response.json();
            const b64Result: string | undefined = data.data?.[0]?.b64_json;

            if (!b64Result) {
              console.warn(`[generate-mockup] ${signLabel} Attempt ${attempt}: No b64_json in OpenAI response`);
              if (attempt < MAX_GENERATION_ATTEMPTS) { lastFailReason = "no_image_in_response"; continue; }
              throw new Error(`Sign ${signIndex + 1} could not be generated. Please try again.`);
            }

            // OpenAI returns raw base64 (PNG). No need to fetch from a URL.
            const genB64 = b64Result;
            const genMime = "image/png";

            lastGeneratedMime = genMime;
            lastGeneratedBase64 = genB64;

            const genDims = getImageDimensions(genB64);
            const genAR = genDims ? aspectRatio(genDims.width, genDims.height) : null;
            console.log(`[generate-mockup] ${signLabel} Attempt ${attempt}: Input=${iterDims?.width}x${iterDims?.height} AR=${iterAR?.toFixed(4)} | Generated=${genDims?.width}x${genDims?.height} AR=${genAR?.toFixed(4)}`);

            let framingPass = true;

            if (iterAR && genAR) {
              const arResult = aspectRatiosMatch(iterAR, genAR);
              if (!arResult.match) {
                console.warn(`[generate-mockup] ${signLabel} Attempt ${attempt}: FAILED aspect ratio. Delta=${(arResult.delta * 100).toFixed(2)}%`);
                framingPass = false;
                lastFailReason = `aspect_ratio_mismatch_${(arResult.delta * 100).toFixed(2)}pct`;
              }
            }

            if (LOVABLE_API_KEY) {
              try {
                const visionResult = await verifyFramingWithVision(currentShopBase64, currentShopMime, genB64, genMime, LOVABLE_API_KEY, "google/gemini-2.5-flash");
                lastVisionResult = visionResult;
                console.log(`[generate-mockup] ${signLabel} Attempt ${attempt}: Vision(advisory): pass=${visionResult.pass} top=${visionResult.topEdgeMatch} bottom=${visionResult.bottomEdgeMatch} left=${visionResult.leftEdgeMatch} right=${visionResult.rightEdgeMatch} reason=${visionResult.reason}`);
              } catch (visionErr) { console.warn(`[generate-mockup] ${signLabel} Attempt ${attempt}: Vision check skipped:`, visionErr); }
            }

            if (framingPass) {
              console.log(`[generate-mockup] ${signLabel} Attempt ${attempt}: ✅ PASSED framing checks.`);
              signSucceeded = true;
              currentShopBase64 = genB64;
              currentShopMime = genMime;
              break;
            }

            if (attempt === MAX_GENERATION_ATTEMPTS) {
              console.error(`[generate-mockup] ${signLabel}: ❌ All ${MAX_GENERATION_ATTEMPTS} attempts failed. Last: ${lastFailReason}`);
              throw new Error(`Sign ${signIndex + 1} could not be generated. Please try again.`);
            }

            console.log(`[generate-mockup] ${signLabel} Attempt ${attempt}: ❌ REJECTED (${lastFailReason}). Retrying...`);
          }

          if (!signSucceeded) throw new Error(`Sign ${signIndex + 1} could not be generated. Please try again.`);
          console.log(`[generate-mockup] ✅ ${signLabel} complete. ${signs.length - signIndex - 1} sign(s) remaining.`);
        }

        const finalUrl = `data:${currentShopMime};base64,${currentShopBase64}`;
        await supabaseAdmin.from("mockup_jobs").update({ status: "complete", result_url: finalUrl, progress: "Complete!", updated_at: new Date().toISOString() }).eq("id", jobId);
        console.log(`[generate-mockup] Job ${jobId} complete.`);

      } catch (error: any) {
        console.error(`[generate-mockup] Job ${jobId} failed:`, error);
        await supabaseAdmin.from("mockup_jobs").update({ status: "failed", error: error.message || "Failed to generate mockup", progress: "Failed", updated_at: new Date().toISOString() }).eq("id", jobId);
      }
    })();

    // @ts-ignore - EdgeRuntime is available in Supabase Edge Functions
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(backgroundWork);
    }

    return new Response(JSON.stringify({ jobId }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 202 });

  } catch (error) {
    console.error("Error in generate-mockup function:", error);
    return new Response(JSON.stringify({ error: "Failed to generate mockup. Please try again." }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 });
  }
});
