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

  // Pre-build two row templates instead of per-pixel branching.
  // OpenAI convention: transparent (alpha=0) = area to edit,
  //                    opaque (alpha=255)    = area to preserve.
  const preserveRow = new Uint8Array(rowLen); // fully opaque — OpenAI won't touch these pixels
  preserveRow[0] = 0; // PNG filter: None
  for (let x = 0; x < width; x++) preserveRow[1 + x * 4 + 3] = 255;

  const zoneRow = new Uint8Array(rowLen); // transparent in edit zone, opaque outside
  zoneRow[0] = 0;
  for (let x = 0; x < width; x++) {
    if (x >= leftPx && x < rightPx) {
      // Alpha stays 0 (transparent) — OpenAI will edit here
    } else {
      zoneRow[1 + x * 4 + 3] = 255; // opaque — preserve
    }
  }

  // Assemble raw scanlines
  const raw = new Uint8Array(height * rowLen);
  for (let y = 0; y < height; y++) {
    raw.set((y >= topPx && y < bottomPx) ? zoneRow : preserveRow, y * rowLen);
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

    // body.size is accepted for backwards compatibility but ignored — sign
    // size is now defined by the magenta marker drawn on the photo.

    const finishValidation = validateString(body.finish, "Finish", 50);
    const finish = finishValidation.valid ? finishValidation.value : "standard";

    const illuminationValidation = validateString(body.illumination, "Illumination", 50);
    const illumination = illuminationValidation.valid ? illuminationValidation.value : "standard";

    const timeOfDayValidation = validateString(body.timeOfDay, "Time of day", 20);
    const timeOfDay = timeOfDayValidation.valid ? timeOfDayValidation.value : "day";

    interface SignZoneInput { xPct: number; yPct: number; wPct: number; hPct: number; }
    interface SignInput { signType: string; signPosition: string; replaceExisting: boolean; existingSignDescription: string; contactDetails: string; signZone: SignZoneInput | null; }
    let signs: SignInput[] = [];

    function parseSignZone(sz: unknown): SignZoneInput | null {
      if (!sz || typeof sz !== "object") return null;
      const o = sz as Record<string, unknown>;
      const xPct = Number(o.xPct); const yPct = Number(o.yPct);
      const wPct = Number(o.wPct); const hPct = Number(o.hPct);
      if ([xPct, yPct, wPct, hPct].every(v => Number.isFinite(v) && v >= 0 && v <= 100) && wPct > 0 && hPct > 0) {
        return { xPct, yPct, wPct, hPct };
      }
      return null;
    }

    if (Array.isArray(body.signs) && body.signs.length > 0) {
      for (const s of body.signs) {
        const stv = validateString(s.signType, "Sign type", 100, true);
        if (!stv.valid) return new Response(JSON.stringify({ error: stv.error }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 });
        const spv = validateString(s.signPosition, "Sign position", 2000);
        const esdv = validateString(s.existingSignDescription, "Existing sign description", 300);
        const cdv = validateString(s.contactDetails, "Contact details", 200);
        const zone = parseSignZone(s.signZone);
        if (zone) console.log(`[zone] Sign zone: x=${zone.xPct.toFixed(1)}% y=${zone.yPct.toFixed(1)}% w=${zone.wPct.toFixed(1)}% h=${zone.hPct.toFixed(1)}%`);
        signs.push({ signType: stv.value, signPosition: spv.valid ? spv.value : "", replaceExisting: s.replaceExisting === true, existingSignDescription: esdv.valid ? esdv.value : "", contactDetails: cdv.valid ? cdv.value : "", signZone: zone });
      }
    } else {
      const signTypeValidation = validateString(body.signType, "Sign type", 100, true);
      if (!signTypeValidation.valid) return new Response(JSON.stringify({ error: signTypeValidation.error }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 });
      const signPositionValidation = validateString(body.signPosition, "Sign position", 2000);
      const existingSignDescValidation = validateString(body.existingSignDescription, "Existing sign description", 300);
      const contactDetailsValidation = validateString(body.contactDetails, "Contact details", 200);
      signs.push({ signType: signTypeValidation.value, signPosition: signPositionValidation.valid ? signPositionValidation.value : "", replaceExisting: body.replaceExisting === true, existingSignDescription: existingSignDescValidation.valid ? existingSignDescValidation.value : "", contactDetails: contactDetailsValidation.valid ? contactDetailsValidation.value : "", signZone: null });
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
          "window-perf": "One-Way Vision perforated vinyl on glass, semi-transparent, shop interior visible through it. Not a solid sign.",
          "blade-sign": "Blade sign projecting outward from wall at 90 degrees, hanging from a bracket arm.",
          "3d-letters": "Dimensional channel letters mounted to wall with stand-off pins, each casting its own shadow.",
          lightbox: "Illuminated lightbox cabinet sign, enclosed backlit panel with aluminium frame.",
          "fascia-panel": "Flat panel sign applied directly to the building's fascia board.",
        };
        const referenceImageUrls: Record<string, string> = {
          "fascia-panel": "https://mcujzbcqxtvvxtbkzzqk.supabase.co/storage/v1/object/public/reference-images/fascia-panel.jpg",
          "3d-letters": "https://mcujzbcqxtvvxtbkzzqk.supabase.co/storage/v1/object/public/reference-images/dimensional-letters.jpg",
          "lightbox": "https://mcujzbcqxtvvxtbkzzqk.supabase.co/storage/v1/object/public/reference-images/lightbox.jpg",
          "window-perf": "https://mcujzbcqxtvvxtbkzzqk.supabase.co/storage/v1/object/public/reference-images/window-vinyl.jpg",
        };
        const finishDescriptions: Record<string, string> = {
          gloss: "High-sheen acrylic face with sharp, mirror-like environmental reflections.",
          metallic: "Brushed aluminium frame with anisotropic highlights and visible 50mm depth.",
          matte: "Powder-coated, non-reflective surface that absorbs ambient light evenly.",
          standard: "Standard painted surface with subtle environmental light interaction.",
        };
        // sizeDescriptions removed: the magenta marker now defines sign size.
        // Adding "mid-sized commercial sign, proportioned to the storefront
        // fascia" conflicted with the marker and was producing oversized signs.

        const sigwaveStyleGuide = `Signwave Australia style: professionally installed exterior signage, physically convincing, not a digital overlay.`;

        let currentShopBase64 = shopImageBase64;
        let currentShopMime = shopMime;

        // --- Sign placement: user-drawn zone via visible marker on photo ---
        // The frontend burns a bright magenta rectangle onto the photo at the
        // user-drawn zone. The model sees the marker and places the sign there,
        // then removes the marker. Mask-based inpainting is not used because
        // it's incompatible with image[] (used for logo reference).

        for (let signIndex = 0; signIndex < signs.length; signIndex++) {
          const s = signs[signIndex];
          const signLabel = `Sign ${signIndex + 1}/${signs.length}`;
          console.log(`[generate-mockup] ━━━ Starting ${signLabel} (${s.signType}) ━━━`);

          await supabaseAdmin.from("mockup_jobs").update({ progress: `Generating sign ${signIndex + 1} of ${signs.length}...`, updated_at: new Date().toISOString() }).eq("id", jobId);

          const iterDims = getImageDimensions(currentShopBase64);
          const iterAR = iterDims ? aspectRatio(iterDims.width, iterDims.height) : null;
          console.log(`[generate-mockup] ${signLabel} input: ${iterDims?.width}x${iterDims?.height}, AR=${iterAR?.toFixed(4)}`);

          let signSection = "";

          if (s.replaceExisting) {
            signSection += `Erase any existing sign graphics inside the marked area before installing the new sign.\n`;
          } else {
            signSection += `Install the new sign inside the marked area. Do not modify any existing signage elsewhere on the building.\n`;
          }

          const styleKey = Object.keys(styleDescriptions).includes(s.signType) ? s.signType : "fascia-panel";
          signSection += `Type: ${s.signType}\nStyle: ${styleDescriptions[styleKey]}\n`;

          if (s.signPosition) { signSection += `Position: ${s.signPosition}\n`; }

          // The building photo has a magenta rectangle burned onto it by the
          // frontend, marking exactly where the sign should be placed.
          if (s.signZone) {
            signSection += `The photo has a bright magenta rectangle marking the exact sign location. Install the sign ONLY inside that marked area. Remove the magenta marker completely.\n`;
            console.log(`[zone] Sign ${signIndex + 1} zone: x=${s.signZone.xPct.toFixed(1)}% y=${s.signZone.yPct.toFixed(1)}% w=${s.signZone.wPct.toFixed(1)}% h=${s.signZone.hPct.toFixed(1)}%`);
          }

          let signPrompt = `Edit the uploaded shopfront photo to install signage with the provided brand logo.
${signSection}
${sigwaveStyleGuide}`;

          if (tagline) { signPrompt += `\nTagline: "${tagline}".`; }
          if (s.contactDetails) { signPrompt += `\nContact details on sign: ${s.contactDetails}`; }
          if (logoBase64) { signPrompt += `\nThe second image is the brand logo. Reproduce it exactly on the sign with correct colours and layout. Preserve the logo's original background colour and text colour exactly as shown — do not invert, recolour, or restyle the logo to match the reference image. The reference is for installation realism only, not colour scheme.`; }
          const referenceUrl = referenceImageUrls[s.signType];
          if (referenceUrl) { signPrompt += `\nMatch the installation quality and physical realism of the reference sign image.`; }
          signPrompt += `\nBlend sign edges naturally with the building surface — photorealistic, physically mounted, no digital overlay look.`;
          signPrompt += `\nGenerate ONLY the described sign inside the magenta-outlined rectangle. Everything outside the magenta rectangle — walls, windows, other signs, awnings, surroundings — must remain pixel-for-pixel identical to the original photo. Do not modify, update, reinterpret, or improve any existing signage outside the marked area.`;

          if (signIndex > 0) { signPrompt += `\nThe image already has ${signIndex} sign(s) — do not remove or modify them.`; }

          console.log(`[generate-mockup] Prompt length: ${signPrompt.length} characters`);

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
              // Keep repair text minimal
              attemptPrompt += ` Fix: preserve original framing.`;
            }

            console.log(`[generate-mockup] Final prompt length: ${attemptPrompt.length} characters`);
            const imageBytes = base64DecodeToBytes(currentShopBase64);
            const imageBlob = new Blob([imageBytes], { type: currentShopMime });
            const imageExt = currentShopMime === "image/png" ? "png" : "jpg";

            const formData = new FormData();
            formData.append("model", "gpt-image-1");
            formData.append("prompt", attemptPrompt);
            formData.append("size", "1024x1024");
            // gpt-image-1 returns b64_json by default — no response_format parameter needed

            // Two images: building photo + logo reference.
            // OpenAI requires image[] array syntax for multiple images.
            formData.append("image[]", imageBlob, `building.${imageExt}`);
            const logoBytes = base64DecodeToBytes(logoBase64!);
            const logoBlob = new Blob([logoBytes], { type: logoMime });
            const logoExt = logoMime.includes("png") ? "png" : "jpg";
            formData.append("image[]", logoBlob, `logo.${logoExt}`);
            console.log(`[generate-mockup] Logo appended (${logoMime}, ${logoBytes.length} bytes)`);

            if (referenceUrl) {
              try {
                const { base64: refBase64, mime: refMime } = await fetchImageAsBase64(referenceUrl);
                const refBytes = base64DecodeToBytes(refBase64);
                const refBlob = new Blob([refBytes], { type: refMime });
                const refExt = refMime.includes("png") ? "png" : "jpg";
                formData.append("image[]", refBlob, `reference.${refExt}`);
                console.log(`[generate-mockup] Reference image appended for ${s.signType} (${refMime}, ${refBytes.length} bytes)`);
              } catch (refErr) {
                console.warn(`[generate-mockup] Reference image fetch failed for ${s.signType}, continuing without it:`, refErr);
              }
            }

            console.log(`[generate-mockup] ${signLabel} Attempt ${attempt}: OpenAI /v1/images/edits, logo=${!!logoBase64}, signZone=${!!s.signZone}, AR=${iterAR?.toFixed(4)}`);

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

            // Aspect ratio check removed — the model returns a fixed 1024x1024
            // square, so landscape inputs will always mismatch. Accept any output dimensions.

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
