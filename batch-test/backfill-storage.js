/**
 * Signwave Trial — One-off backfill: move legacy base64 mockups to Storage.
 *
 * Background: mockup_jobs.result_url used to store the entire generated
 * PNG as a `data:image/png;base64,...` string. That filled the Free-plan
 * DB at 227% of quota. The edge function now writes new mockups to the
 * 'mockups' Storage bucket, but the existing 371 legacy rows still hold
 * their bytes in the DB column.
 *
 * This script:
 *   1. Queries every mockup_jobs row whose result_url starts with 'data:'.
 *   2. For each row, decodes the base64, uploads it to Storage at
 *      <id>.png, then UPDATEs result_url to the new public URL.
 *   3. Runs uploads in small parallel batches so it completes in ~5 min.
 *
 * After this script finishes successfully, EVERY row in mockup_jobs has
 * a short URL (~100 bytes) instead of a fat data URL. The franchisees
 * keep their full mockup history; the DB stops being the bottleneck.
 *
 * Notes:
 *   - Postgres won't immediately reclaim the freed bytes on disk because
 *     UPDATE leaves the old TOAST chunks as dead tuples. You'll need to
 *     run `VACUUM FULL mockup_jobs;` afterwards (as a single statement
 *     in Supabase SQL editor, NOT inside a transaction block).
 *   - Uses the service-role key — it bypasses RLS to read/write any row
 *     and upload to a public bucket. Add the key to .env.local as
 *     SUPABASE_SERVICE_ROLE_KEY. Treat it like a password.
 *
 * Usage:
 *   1. Add SUPABASE_SERVICE_ROLE_KEY to .env.local (find it in Supabase
 *      dashboard → Project settings → API → "service_role" key — NEVER
 *      check this into git).
 *   2. node batch-test/backfill-storage.js
 *   3. After completion, optionally run VACUUM FULL in the SQL editor.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env.local') });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  console.error('Service role key: Supabase dashboard → Settings → API → "service_role" (secret).');
  process.exit(1);
}

const BUCKET = 'Mockups';
const PAUSE_MS = 250; // small breather between rows to avoid REST rate spikes
const MAX_RETRIES = 2; // per-step retry budget; "57014 statement timeout" is the main symptom we're guarding against

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return /timeout|57014|upstream|fetch failed|ECONNRESET|EAI_AGAIN/i.test(msg);
}

async function withRetry(label, fn) {
  let attempt = 0;
  let lastErr;
  while (attempt <= MAX_RETRIES) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt > MAX_RETRIES || !isRetryable(err)) throw err;
      const backoff = 1000 * attempt; // 1s, 2s
      console.log(`    ${label} retry ${attempt}/${MAX_RETRIES} after ${backoff}ms (${err.message || err})`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function processRowById(id, index, total) {
  const tag = `[${(index + 1).toString().padStart(3)}/${total}] ${id.slice(0, 8)}`;
  try {
    // Fetch just this row's result_url. Wrapped in retry because even
    // single-row fetches of 2-3MB columns occasionally hit the REST timeout.
    const row = await withRetry(`${tag} fetch`, async () => {
      const { data, error } = await supabase
        .from('mockup_jobs')
        .select('result_url')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    });

    if (!row || !row.result_url) {
      return { id, status: 'skipped', reason: 'no result_url' };
    }

    // Skip rows already on Storage (idempotent re-run safety — most rows
    // on a re-run will hit this and return fast).
    if (!row.result_url.startsWith('data:')) {
      return { id, status: 'skipped', reason: 'already migrated' };
    }

    const match = row.result_url.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return { id, status: 'skipped', reason: 'malformed data URL' };
    }
    const mime = match[1];
    const base64 = match[2];
    const buffer = Buffer.from(base64, 'base64');
    const fileName = `${id}.png`;

    await withRetry(`${tag} upload`, async () => {
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(fileName, buffer, {
          contentType: mime,
          upsert: true,
          cacheControl: '31536000',
        });
      if (error) throw error;
    });

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(fileName);

    await withRetry(`${tag} update`, async () => {
      const { error } = await supabase
        .from('mockup_jobs')
        .update({ result_url: pub.publicUrl })
        .eq('id', id);
      if (error) throw error;
    });

    console.log(`  ${tag} → ${(buffer.length / 1024).toFixed(0)} KB`);
    return { id, status: 'success' };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`  ${tag} FAILED — ${msg}`);
    return { id, status: 'failed', reason: msg };
  }
}

async function main() {
  console.log('Querying candidate row IDs (lightweight — no result_url payload)…');
  // Two-step approach to avoid statement timeout:
  //   1. Fetch ONLY ids of completed rows (status='complete' is indexed +
  //      cheap; no need to read the huge result_url TOAST data).
  //   2. processRowById then fetches and migrates each row individually.
  // Rows already on Storage are silently skipped by processRowById, so this
  // script is safe to re-run.
  const { data: idRows, error: qErr } = await supabase
    .from('mockup_jobs')
    .select('id')
    .eq('status', 'complete')
    .order('created_at', { ascending: true });

  if (qErr) {
    console.error('Query failed:', qErr);
    process.exit(1);
  }

  if (!idRows || idRows.length === 0) {
    console.log('No completed rows found. Nothing to migrate.');
    return;
  }

  console.log(`Found ${idRows.length} completed rows. Migrating sequentially (one at a time, with retry on timeout)...\n`);

  const start = Date.now();
  const results = [];
  for (let i = 0; i < idRows.length; i++) {
    const result = await processRowById(idRows[i].id, i, idRows.length);
    results.push(result);
    // Pause briefly between rows to avoid hammering the REST gateway
    // (don't pause after the last row).
    if (i < idRows.length - 1) await sleep(PAUSE_MS);
  }

  const success = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n============================================`);
  console.log(`  BACKFILL COMPLETE`);
  console.log(`  Total: ${idRows.length} | OK: ${success} | Failed: ${failed} | Skipped: ${skipped}`);
  console.log(`  Time: ${elapsed}s`);
  console.log(`============================================\n`);

  if (failed > 0) {
    console.log('Failed rows (these still hold base64 — re-run to retry):');
    results.filter(r => r.status === 'failed').forEach(r => {
      console.log(`  ${r.id.slice(0, 8)}: ${r.reason}`);
    });
  }

  console.log('\nNext step: run `VACUUM FULL mockup_jobs;` in the Supabase SQL editor');
  console.log('as a single standalone statement so Postgres reclaims the dead-tuple bytes.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
