/**
 * Signwave Batch Test Runner
 *
 * Reads test_cases.json, sends each case to the generate-mockup edge function,
 * polls for completion, downloads result images, and writes a summary CSV.
 *
 * Usage:  node batch-test/run-tests.js            (all tests)
 *         node batch-test/run-tests.js --single   (TC01 only)
 *         node batch-test/run-tests.js --id TC06  (specific test by ID)
 * Prereqs: npm install, .env.local populated with test credentials
 */

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';

// ---------- resolve paths relative to project root ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Load .env.local from project root
const ENV_PATH = path.join(PROJECT_ROOT, '.env.local');
const envResult = dotenv.config({ path: ENV_PATH });
if (envResult.error) {
  console.error('Failed to load .env.local:', envResult.error.message);
  console.error('Looked at:', ENV_PATH);
  process.exit(1);
}

const TEST_CASES_PATH = path.join(__dirname, 'test_cases.json');
const TEST_IMAGES_DIR = path.join(PROJECT_ROOT, 'test_images');
const LOGO_PATH = path.join(PROJECT_ROOT, 'public', 'signwave-logo.png');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'test_outputs');
const CSV_PATH = path.join(PROJECT_ROOT, 'test_results.csv');

// ---------- config from .env.local ----------
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const TEST_EMAIL = process.env.TEST_USER_EMAIL;
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD;
const EDGE_FN_URL = `${SUPABASE_URL}/functions/v1/generate-mockup`;

const POLL_INTERVAL_MS = 5_000;   // 5 seconds between polls
const MAX_WAIT_MS = 5 * 60_000;  // 5 minutes max per job

// ---------- preflight checks ----------
function preflight() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY');
  if (!TEST_EMAIL) missing.push('TEST_USER_EMAIL');
  if (!TEST_PASSWORD) missing.push('TEST_USER_PASSWORD');
  if (missing.length) {
    console.error(`Missing env vars in .env.local: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!fs.existsSync(TEST_CASES_PATH)) {
    console.error(`Test cases not found at ${TEST_CASES_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(LOGO_PATH)) {
    console.error(`Logo not found at ${LOGO_PATH}`);
    process.exit(1);
  }
  // Ensure output dir exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ---------- helpers ----------

/** Read a file and return a base64-encoded data URI */
function toBase64DataUri(filePath, mimeType = 'image/png') {
  const buf = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${buf.toString('base64')}`;
}

/**
 * Resolve building image path with case-insensitive matching.
 * The test cases reference "building_1.png" but actual files may be "Building_1.png".
 */
function resolveBuildingImage(filename) {
  // Try exact match first
  const exact = path.join(TEST_IMAGES_DIR, filename);
  if (fs.existsSync(exact)) return exact;

  // Case-insensitive search
  const files = fs.readdirSync(TEST_IMAGES_DIR);
  const match = files.find(f => f.toLowerCase() === filename.toLowerCase());
  if (match) return path.join(TEST_IMAGES_DIR, match);

  return null;
}

/** Sleep for ms milliseconds */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Format seconds with one decimal */
function fmtSec(ms) {
  return (ms / 1000).toFixed(1);
}

// ---------- main ----------
async function main() {
  preflight();

  // --- Load test cases ---
  const singleMode = process.argv.includes('--single');
  const idFlagIndex = process.argv.indexOf('--id');
  const idFilter = idFlagIndex !== -1 ? process.argv[idFlagIndex + 1] : null;

  let testCases = JSON.parse(fs.readFileSync(TEST_CASES_PATH, 'utf-8'));
  if (idFilter) {
    const match = testCases.find(tc => tc.id.toUpperCase() === idFilter.toUpperCase());
    if (!match) {
      console.error(`No test case found with ID "${idFilter}". Available: ${testCases.map(tc => tc.id).join(', ')}`);
      process.exit(1);
    }
    testCases = [match];
    console.log(`\nSingle-test mode: running ${match.id} only\n`);
  } else if (singleMode) {
    testCases = [testCases[0]];
    console.log(`\nSingle-test mode: running TC01 only\n`);
  } else {
    console.log(`\nLoaded ${testCases.length} test cases\n`);
  }

  // --- Load default logo once (used when a test case has no per-case logo) ---
  const defaultLogoBase64 = toBase64DataUri(LOGO_PATH);

  // --- Authenticate with Supabase ---
  console.log(`Signing in as ${TEST_EMAIL}...`);
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (authError) {
    console.error('Auth failed:', authError.message);
    process.exit(1);
  }
  const accessToken = authData.session.access_token;
  console.log('Authenticated successfully.\n');

  // --- Run each test sequentially ---
  const results = [];

  for (const tc of testCases) {
    const tag = `[${tc.id}]`;
    const buildingFile = tc.building;
    const signType = tc.sign_type;
    const outputFilename = `${tc.id}_${buildingFile.replace('.png', '')}_${signType}.png`;

    console.log(`${tag} Starting — ${buildingFile} / ${signType}`);

    const start = Date.now();
    let status = 'unknown';
    let errorMsg = '';
    let savedFile = '';

    try {
      // Load building image
      const buildingPath = resolveBuildingImage(buildingFile);
      if (!buildingPath) {
        throw new Error(`Building image not found: ${buildingFile}`);
      }
      const shopBase64 = toBase64DataUri(buildingPath);

      console.log(`${tag} shopImage base64 preview: ${shopBase64.substring(0, 50)}...`);

      // Per-case logo override (Supabase URL or any other string accepted by
      // the edge function's validateImageUrl) — falls back to the default
      // local Signwave logo when the test case doesn't specify one.
      const logoForCase = tc.logo || defaultLogoBase64;
      if (tc.logo) console.log(`${tag} Using per-case logo: ${tc.logo}`);

      // POST to edge function
      const payload = {
        shopImageUrl: shopBase64,
        logoUrl: logoForCase,
        signs: [
          {
            signType: signType,
            signPosition: tc.spec,
            replaceExisting: true,
            existingSignDescription: '',
          },
        ],
      };

      const res = await fetch(EDGE_FN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Edge function returned ${res.status}: ${body}`);
      }

      const { jobId } = await res.json();
      if (!jobId) throw new Error('No jobId returned from edge function');

      console.log(`${tag} Job ID: ${jobId} — polling...`);

      // Poll for completion
      const pollStart = Date.now();
      let job = null;

      while (Date.now() - pollStart < MAX_WAIT_MS) {
        await sleep(POLL_INTERVAL_MS);

        const { data, error } = await supabase
          .from('mockup_jobs')
          .select('status, result_url, error')
          .eq('id', jobId)
          .single();

        if (error) {
          console.warn(`${tag} Poll error: ${error.message}`);
          continue;
        }

        if (data.status === 'complete') {
          job = data;
          break;
        }
        if (data.status === 'failed' || data.status === 'error') {
          throw new Error(data.error || 'Job failed with no error message');
        }
      }

      if (!job) {
        throw new Error('Timed out after 5 minutes');
      }

      // Download / decode result image
      let imgBuffer;
      if (job.result_url.startsWith('data:')) {
        // Decode base64 data URI directly (avoids fetch() issues with large data URIs)
        const b64 = job.result_url.split(',')[1];
        if (!b64) throw new Error('Empty data URI in result_url');
        imgBuffer = Buffer.from(b64, 'base64');
      } else {
        const imgRes = await fetch(job.result_url);
        if (!imgRes.ok) {
          throw new Error(`Failed to download result: ${imgRes.status}`);
        }
        imgBuffer = Buffer.from(await imgRes.arrayBuffer());
      }
      const outPath = path.join(OUTPUT_DIR, outputFilename);
      fs.writeFileSync(outPath, imgBuffer);
      console.log(`${tag} Wrote ${(imgBuffer.length / 1024).toFixed(0)} KB to ${outPath}`);

      const elapsed = Date.now() - start;
      status = 'complete';
      savedFile = outputFilename;
      console.log(`${tag} Complete in ${fmtSec(elapsed)}s — saved to test_outputs/${outputFilename}`);

    } catch (err) {
      const elapsed = Date.now() - start;
      status = err.message.includes('Timed out') ? 'timeout' : 'error';
      errorMsg = err.message;
      console.error(`${tag} ERROR — ${err.message}`);
    }

    const duration = ((Date.now() - start) / 1000).toFixed(1);

    results.push({
      id: tc.id,
      building: buildingFile,
      sign_type: signType,
      description: tc.description,
      status,
      duration_seconds: duration,
      output_file: savedFile || '',
      error: errorMsg,
    });
  }

  // --- Write summary CSV ---
  const csvHeader = 'id,building,sign_type,description,status,duration_seconds,output_file,error';
  const csvRows = results.map(r =>
    [r.id, r.building, r.sign_type, `"${r.description}"`, r.status, r.duration_seconds, r.output_file, `"${r.error}"`].join(',')
  );
  const csv = [csvHeader, ...csvRows].join('\n');
  fs.writeFileSync(CSV_PATH, csv, 'utf-8');

  // --- Print summary ---
  const complete = results.filter(r => r.status === 'complete').length;
  const errors = results.filter(r => r.status === 'error').length;
  const timeouts = results.filter(r => r.status === 'timeout').length;

  console.log('\n========================================');
  console.log(`  BATCH TEST COMPLETE`);
  console.log(`  Total: ${results.length}  |  OK: ${complete}  |  Errors: ${errors}  |  Timeouts: ${timeouts}`);
  console.log(`  CSV saved to: test_results.csv`);
  console.log('========================================\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
