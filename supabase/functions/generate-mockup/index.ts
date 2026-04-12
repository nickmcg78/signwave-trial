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

const ASPECT_RATIO_TOLERANCE = 0.20;
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

    const token = authHeader.replace("Bearer ", "");
    try {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("Invalid JWT format");
      const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
      if (!payload.sub || payload.role !== "authenticated") throw new Error("Not authenticated");
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Token expired");
    } catch (jwtError) {
      console.error("JWT validation failed:", jwtError);
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

    interface SignInput { signType: string; signPosition: string; replaceExisting: boolean; existingSignDescription: string; }
    let signs: SignInput[] = [];

    if (Array.isArray(body.signs) && body.signs.length > 0) {
      for (const s of body.signs) {
        const stv = validateString(s.signType, "Sign type", 100, true);
        if (!stv.valid) return new Response(JSON.stringify({ error: stv.error }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 });
        const spv = validateString(s.signPosition, "Sign position", 100);
        const esdv = validateString(s.existingSignDescription, "Existing sign description", 300);
        signs.push({ signType: stv.value, signPosition: spv.valid ? spv.value : "", replaceExisting: s.replaceExisting === true, existingSignDescription: esdv.valid ? esdv.value : "" });
      }
    } else {
      const signTypeValidation = validateString(body.signType, "Sign type", 100, true);
      if (!signTypeValidation.valid) return new Response(JSON.stringify({ error: signTypeValidation.error }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 });
      const signPositionValidation = validateString(body.signPosition, "Sign position", 100);
      const existingSignDescValidation = validateString(body.existingSignDescription, "Existing sign description", 300);
      signs.push({ signType: signTypeValidation.value, signPosition: signPositionValidation.valid ? signPositionValidation.value : "", replaceExisting: body.replaceExisting === true, existingSignDescription: existingSignDescValidation.valid ? existingSignDescValidation.value : "" });
    }

    console.log(`[generate-mockup] ${signs.length} sign(s) requested`);

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) return new Response(JSON.stringify({ error: "OpenAI API key not configured" }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 });

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

    const supabaseAdmin = getSupabaseAdmin();
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
          "window-perf": "One-Way Vision vinyl (perforated window film) applied flat ON the glass surface. Zero depth.",
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
Every sign must look like it was fabricated by a professional sign company and physically installed on the building.`;

        let currentShopBase64 = shopImageBase64;
        let currentShopMime = shopMime;

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
            const sizingConstraint = `• SIZING CONSTRAINT (CRITICAL):\n  – The new sign MUST fit WITHIN the existing physical fascia/structure dimensions.\n  – Do NOT enlarge, extend, or reshape any architectural element to accommodate the sign.\n  – The fascia height, width, and position must remain IDENTICAL to the original photograph.\n  – If the logo does not fit at full size, SCALE IT DOWN until it fits within the existing fascia boundary.\n  – The building is IMMUTABLE — only the sign artwork changes, never the structure.\n`;
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

${signSection}`;

          if (tagline) { signPrompt += `\nTagline: Include the tagline "${tagline}" as part of the signage display.`; }
          if (logoBase64) { signPrompt += `\nLOGO: The second image provided is the client's logo. Reproduce it accurately on the sign — correct colours, correct proportions, legible text.`; }

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
BLACK LEVEL MATCHING: All dark tones must match the original photograph's black levels. Do NOT use pure #000000.`;

          if (signIndex > 0) { signPrompt += `\n\nPREVIOUS SIGNS: The input image already contains ${signIndex} previously rendered sign(s). Do NOT remove, modify, or obscure them. Only add the new sign described above.`; }

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

            const formData = new FormData();
            formData.append("model", "gpt-image-1");
            formData.append("prompt", attemptPrompt);
            formData.append("n", "1");
            const bestSize = iterAR && iterAR > 1.2 ? "1536x1024" : iterAR && iterAR < 0.8 ? "1024x1536" : "1024x1024";
            formData.append("size", bestSize);
            console.log(`[generate-mockup] ${signLabel} Attempt ${attempt}: size=${bestSize}, AR=${iterAR?.toFixed(4)}`);

            const inputBytes = base64DecodeToBytes(currentShopBase64);
            const inputBlob = new Blob([inputBytes], { type: currentShopMime });
            formData.append("image[]", inputBlob, `shop.${currentShopMime === "image/png" ? "png" : "jpg"}`);

            if (logoBase64) {
              const logoBytes = base64DecodeToBytes(logoBase64);
              const logoFileBlob = new Blob([logoBytes], { type: logoMime });
              formData.append("image[]", logoFileBlob, `logo.${logoMime === "image/png" ? "png" : "jpg"}`);
            }

            const response = await fetch("https://api.openai.com/v1/images/edits", {
              method: "POST",
              headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
              body: formData,
            });

            if (!response.ok) {
              const errorBody = await response.text();
              console.error(`[generate-mockup] ${signLabel} Attempt ${attempt} OpenAI API error:`, response.status, errorBody);
              if (response.status === 429) throw new Error("Too many AI requests. Please wait a moment and try again.");
              if (response.status === 400) {
                let userMessage = "The AI could not process the provided image. Please try a different photo or re-upload.";
                try {
                  const errJson = JSON.parse(errorBody);
                  const code = errJson?.error?.code;
                  if (code === "billing_hard_limit_reached" || code === "insufficient_quota") userMessage = "AI billing limit reached. Please check your OpenAI account billing settings.";
                } catch { /* use default message */ }
                throw new Error(userMessage);
              }
              if (response.status === 401) throw new Error("OpenAI API key invalid or not configured correctly.");
              if (attempt < MAX_GENERATION_ATTEMPTS) { lastFailReason = `api_error_${response.status}`; continue; }
              throw new Error(`Sign ${signIndex + 1} could not be generated. Please try again.`);
            }

            const data = await response.json();
            const genB64: string | undefined = data.data?.[0]?.b64_json;

            if (!genB64) {
              console.warn(`[generate-mockup] ${signLabel} Attempt ${attempt}: No image in OpenAI response`);
              if (attempt < MAX_GENERATION_ATTEMPTS) { lastFailReason = "no_image_in_response"; continue; }
              throw new Error(`Sign ${signIndex + 1} could not be generated. Please try again.`);
            }

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
