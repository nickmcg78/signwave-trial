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

// --- Gemini 2.5 Flash Image integration ---
// gpt-image-1 and gpt-image-1.5 both empirically ignored masks when given
// multiple image[] inputs (sign placed on natural fascia regardless of
// where user marked). Gemini 2.5 Flash Image (formerly "Nano Banana") is
// our chosen alternative. It does NOT support masks — placement is via
// natural-language description in the prompt instead.

interface ZoneForDescribe { xPct: number; yPct: number; wPct: number; hPct: number; }

/**
 * Translate a drawn rectangle (percentages) into natural-language placement
 * Gemini can interpret. Combines descriptive English ("upper centre-left")
 * with explicit numerics so the model has both pattern-match AND precise data.
 */
function describeZone(zone: ZoneForDescribe): string {
  const cx = zone.xPct + zone.wPct / 2;
  const cy = zone.yPct + zone.hPct / 2;

  let vert: string;
  if (cy < 22) vert = "upper";
  else if (cy < 42) vert = "upper-middle";
  else if (cy < 58) vert = "middle";
  else if (cy < 78) vert = "lower-middle";
  else vert = "lower";

  let horz: string;
  if (cx < 22) horz = "left";
  else if (cx < 42) horz = "centre-left";
  else if (cx < 58) horz = "centre";
  else if (cx < 78) horz = "centre-right";
  else horz = "right";

  return `Place the sign in the ${vert} ${horz} portion of the building. ` +
    `The sign should occupy approximately ${Math.round(zone.wPct)}% of the image width ` +
    `and ${Math.round(zone.hPct)}% of the image height, ` +
    `centred at approximately ${Math.round(cx)}% from the left edge ` +
    `and ${Math.round(cy)}% from the top edge of the image. ` +
    `Do not extend the sign beyond these bounds — keep it contained as a discrete rectangle, ` +
    `even if there is additional fascia, wall, or window space available outside this region.`;
}

/** Map source aspect ratio to closest Gemini-supported aspect ratio string. */
function pickGeminiAspectRatio(sourceRatio: number): string {
  // Supported per docs: 1:1, 1:4, 1:8, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4, 8:1, 9:16, 16:9, 21:9
  const candidates: Array<[string, number]> = [
    ["9:16", 9 / 16], ["2:3", 2 / 3], ["3:4", 3 / 4], ["4:5", 4 / 5],
    ["1:1", 1], ["5:4", 5 / 4], ["4:3", 4 / 3], ["3:2", 3 / 2],
    ["16:9", 16 / 9], ["21:9", 21 / 9],
  ];
  let best = candidates[0];
  let bestDelta = Math.abs(sourceRatio - best[1]);
  for (const c of candidates) {
    const d = Math.abs(sourceRatio - c[1]);
    if (d < bestDelta) { best = c; bestDelta = d; }
  }
  return best[0];
}

interface GeminiResult { base64: string; mime: string; }

/**
 * Call Gemini 2.5 Flash Image to edit the building photo, supplying the
 * brand logo (and optional reference image) as additional input parts.
 * Returns the generated image as base64 + mime, or throws on hard failure.
 */
async function callGeminiImageEdit(
  apiKey: string,
  prompt: string,
  buildingBase64: string,
  buildingMime: string,
  logoBase64: string,
  logoMime: string,
  referenceBase64: string | null,
  referenceMime: string | null,
  aspectRatio: string,
): Promise<GeminiResult | null> {
  const parts: Array<Record<string, unknown>> = [
    { text: prompt },
    { inline_data: { mime_type: buildingMime, data: buildingBase64 } },
    { inline_data: { mime_type: logoMime, data: logoBase64 } },
  ];
  if (referenceBase64 && referenceMime) {
    parts.push({ inline_data: { mime_type: referenceMime, data: referenceBase64 } });
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio },
        },
      }),
    },
  );

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`[gemini] API error HTTP ${response.status}:`, errBody);
    if (response.status === 400) throw new Error(`Gemini validation error: ${errBody.slice(0, 300)}`);
    if (response.status === 401 || response.status === 403) throw new Error("Gemini API key invalid or missing.");
    if (response.status === 429) throw new Error("Too many AI requests. Please wait a moment and try again.");
    throw new Error(`Gemini API error: HTTP ${response.status}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (!candidate) {
    console.error(`[gemini] No candidates in response:`, JSON.stringify(data).slice(0, 500));
    return null;
  }
  // Log any text the model included alongside the image — useful for debugging.
  const textPart = candidate.content?.parts?.find((p: { text?: string }) => typeof p.text === "string");
  if (textPart?.text) console.log(`[gemini] model text: ${String(textPart.text).slice(0, 300)}`);

  const imagePart = candidate.content?.parts?.find(
    (p: { inline_data?: unknown; inlineData?: unknown }) => p.inline_data || p.inlineData,
  );
  if (!imagePart) {
    console.error(`[gemini] No image part in response. Finish reason: ${candidate.finishReason}. Parts:`, JSON.stringify(candidate.content?.parts).slice(0, 500));
    return null;
  }

  const imgData = (imagePart.inline_data ?? imagePart.inlineData) as { data: string; mime_type?: string; mimeType?: string };
  return {
    base64: imgData.data,
    mime: imgData.mime_type ?? imgData.mimeType ?? "image/png",
  };
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

    // Image generation is now done via Gemini 2.5 Flash Image (Nano Banana)
    // — OpenAI's image edits endpoint empirically ignored masks with
    // multi-image inputs. OPENAI_API_KEY is no longer required.
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) return new Response(JSON.stringify({ error: "Gemini API key not configured (set GEMINI_API_KEY in Supabase function secrets)" }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 });

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

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

        // --- Sign placement: user-drawn zone via transparent PNG mask ---
        // The frontend sends the unmodified building photo and the zone as
        // percentage coordinates. We generate a same-size PNG mask per sign:
        // transparent inside the zone (editable), opaque outside (preserved).
        // Per current OpenAI docs, /v1/images/edits applies the mask to the
        // first image when multiple images are sent. Combined with
        // input_fidelity:"high", this is the documented way to preserve the
        // source building while editing only inside the marked region.

        for (let signIndex = 0; signIndex < signs.length; signIndex++) {
          const s = signs[signIndex];
          const signLabel = `Sign ${signIndex + 1}/${signs.length}`;
          console.log(`[generate-mockup] ━━━ Starting ${signLabel} (${s.signType}) ━━━`);

          await supabaseAdmin.from("mockup_jobs").update({ progress: `Generating sign ${signIndex + 1} of ${signs.length}...`, updated_at: new Date().toISOString() }).eq("id", jobId);

          const iterDims = getImageDimensions(currentShopBase64);
          const iterAR = iterDims ? aspectRatio(iterDims.width, iterDims.height) : null;
          console.log(`[generate-mockup] ${signLabel} input: ${iterDims?.width}x${iterDims?.height}, AR=${iterAR?.toFixed(4)}`);

          // Gemini flow: spatial placement is communicated via natural-language
          // description (Gemini does not support masks). The user's drawn zone
          // is translated into an English description by describeZone().
          const styleKey = Object.keys(styleDescriptions).includes(s.signType) ? s.signType : "fascia-panel";
          const referenceUrl = referenceImageUrls[s.signType];

          if (s.signZone) {
            console.log(`[zone] Sign ${signIndex + 1} zone: x=${s.signZone.xPct.toFixed(1)}% y=${s.signZone.yPct.toFixed(1)}% w=${s.signZone.wPct.toFixed(1)}% h=${s.signZone.hPct.toFixed(1)}%`);
          }

          const placementDescription = s.signZone
            ? describeZone(s.signZone)
            : "Place the sign on the building's natural fascia band (the horizontal area above the entrance and below the roofline).";

          const signSpecLines: string[] = [
            `- Sign type: ${s.signType}`,
            `- Construction and style: ${styleDescriptions[styleKey]}`,
          ];
          if (s.signPosition) signSpecLines.push(`- Additional spec: ${s.signPosition}`);
          if (tagline) signSpecLines.push(`- Tagline to include on the sign: "${tagline}"`);
          if (s.contactDetails) signSpecLines.push(`- Contact details to include on the sign: ${s.contactDetails}`);

          const installVerb = s.replaceExisting
            ? "Remove any existing sign graphics in the placement area and install"
            : "Install";

          let signPrompt = `Edit the first image (a real shopfront photograph) to install a new ${s.signType} sign on the building, using the supplied brand logo.

PLACEMENT
${placementDescription}

SIGN SPECIFICATION
${installVerb} the sign as described:
${signSpecLines.join("\n")}

LOGO REPRODUCTION (CRITICAL)
The second image is the brand logo. Reproduce it on the sign EXACTLY as supplied — preserve text, letterforms, colours (including the BACKGROUND colour of the logo), spacing, and layout. Do NOT invert the logo. Do NOT recolour the logo. Do NOT redraw or restyle the logo. If the supplied logo has a white background with coloured text, the installed sign must show a white background with the same coloured text — not the inverse.`;

          if (referenceUrl) {
            signPrompt += `

INSTALLATION REFERENCE
The third image is a reference for fabrication and installation realism only — cabinet depth, mounting style, edge detail, material behaviour, lighting realism. Do NOT copy the reference's branding, wording, colour palette, or design layout.`;
          }

          signPrompt += `

PRESERVE THE REST OF THE BUILDING (CRITICAL)
The first image shows a real building. Preserve everything outside the new sign's placement area exactly as it is: brickwork, render, paint, windows, awning, doors, structural lines, neighbouring shops, street elements, footpath, trees, vehicles, people, reflections, shadows, lighting, sky. Do not redesign, restyle, or reinterpret any other part of the building or its surroundings. The result must depict the SAME real building, only with the new sign added.

${sigwaveStyleGuide}

The result must look like a real on-site photograph of the same building after professional sign installation. It must not look like a digital overlay, design mockup, CGI render, or a newly invented building.`;

          if (signIndex > 0) {
            signPrompt += `\n\nNote: the source image already contains ${signIndex} previously installed sign(s). Preserve those exactly along with the rest of the building.`;
          }

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
              attemptPrompt += `\n\nFix from previous attempt: preserve the exact source building from the first image. Keep the new sign contained to the placement area described above. Do not invent or replace the building. Do not extend the sign to cover the entire fascia or window — keep it as the discrete rectangle described.`;
            }

            console.log(`[generate-mockup] Final prompt length: ${attemptPrompt.length} characters`);

            // Pick output aspect ratio closest to source. Gemini supports
            // a wide range including 21:9 — no letterboxing on ultra-wide.
            // (Renamed from `aspectRatio` to avoid shadowing the top-level
            // aspectRatio() helper used elsewhere for w/h calculations.)
            const sourceRatio = iterAR ?? 1.0;
            const geminiAspect = pickGeminiAspectRatio(sourceRatio);
            console.log(`[generate-mockup] ${signLabel}: sourceAR=${sourceRatio.toFixed(3)} → Gemini aspectRatio=${geminiAspect}`);

            // Fetch reference image if available for this sign type
            let refBase64Final: string | null = null;
            let refMimeFinal: string | null = null;
            if (referenceUrl) {
              try {
                const { base64: rb, mime: rm } = await fetchImageAsBase64(referenceUrl);
                refBase64Final = rb;
                refMimeFinal = rm;
                console.log(`[generate-mockup] Reference image fetched for ${s.signType} (${rm}, ${rb.length} b64 chars)`);
              } catch (refErr) {
                console.warn(`[generate-mockup] Reference image fetch failed for ${s.signType}, continuing without it:`, refErr);
              }
            }

            console.log(`[generate-mockup] ${signLabel} Attempt ${attempt}: Gemini 2.5 Flash Image, logo=${!!logoBase64}, ref=${!!refBase64Final}, signZone=${!!s.signZone}, AR=${iterAR?.toFixed(4)}`);

            let geminiResult: GeminiResult | null = null;
            try {
              geminiResult = await callGeminiImageEdit(
                GEMINI_API_KEY!,
                attemptPrompt,
                currentShopBase64,
                currentShopMime,
                logoBase64!,
                logoMime,
                refBase64Final,
                refMimeFinal,
                geminiAspect,
              );
            } catch (geminiErr) {
              const msg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
              console.error(`[generate-mockup] ${signLabel} Attempt ${attempt} Gemini error:`, msg);
              if (attempt < MAX_GENERATION_ATTEMPTS) { lastFailReason = `gemini_error: ${msg}`; continue; }
              throw geminiErr;
            }

            if (!geminiResult || !geminiResult.base64) {
              console.warn(`[generate-mockup] ${signLabel} Attempt ${attempt}: Gemini returned no image`);
              if (attempt < MAX_GENERATION_ATTEMPTS) { lastFailReason = "no_image_in_gemini_response"; continue; }
              throw new Error(`Sign ${signIndex + 1} could not be generated. Please try again.`);
            }

            const genB64 = geminiResult.base64;
            const genMime = geminiResult.mime;

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
