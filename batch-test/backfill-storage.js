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

const BUCKET = 'mockups';
const CHUNK_SIZE = 5; // parallel uploads per batch; tune up/down based on rate-limit headroom

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function processRow(row, index, total) {
  const tag = `[${(index + 1).toString().padStart(3)}/${total}] ${row.id.slice(0, 8)}`;
  try {
    const dataUrl = row.result_url;
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return { id: row.id, status: 'skipped', reason: 'malformed data URL' };
    }
    const mime = match[1];
    const base64 = match[2];
    const buffer = Buffer.from(base64, 'base64');
    const fileName = `${row.id}.png`;

    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(fileName, buffer, {
        contentType: mime,
        upsert: true,
        cacheControl: '31536000',
      });
    if (uploadErr) throw uploadErr;

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(fileName);

    const { error: updateErr } = await supabase
      .from('mockup_jobs')
      .update({ result_url: pub.publicUrl })
      .eq('id', row.id);
    if (updateErr) throw updateErr;

    console.log(`  ${tag} → ${(buffer.length / 1024).toFixed(0)} KB`);
    return { id: row.id, status: 'success' };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`  ${tag} FAILED — ${msg}`);
    return { id: row.id, status: 'failed', reason: msg };
  }
}

async function main() {
  console.log('Querying legacy base64 rows…');
  const { data: rows, error: qErr } = await supabase
    .from('mockup_jobs')
    .select('id, result_url')
    .like('result_url', 'data:image/%')
    .order('created_at', { ascending: true });

  if (qErr) {
    console.error('Query failed:', qErr);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log('No legacy rows to migrate. All result_urls already point to Storage.');
    return;
  }

  console.log(`Found ${rows.length} legacy rows. Uploading in chunks of ${CHUNK_SIZE}...\n`);

  const start = Date.now();
  const results = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const chunkResults = await Promise.all(
      chunk.map((row, idxInChunk) => processRow(row, i + idxInChunk, rows.length))
    );
    results.push(...chunkResults);
  }

  const success = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n============================================`);
  console.log(`  BACKFILL COMPLETE`);
  console.log(`  Total: ${rows.length} | OK: ${success} | Failed: ${failed} | Skipped: ${skipped}`);
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
