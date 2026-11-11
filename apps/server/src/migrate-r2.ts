import { createServer } from './index.ts';

// Run explicitly with R2_GATEWAY_URL, R2_GATEWAY_SECRET and DATA_DIR set.
// Optional --id=<32hex> limits the migration to one document.
const argument = process.argv.slice(2).find(value => value.startsWith('--id='));
const onlyId = argument?.slice('--id='.length);
if (onlyId && !/^[0-9a-f]{32}$/.test(onlyId)) throw new Error('Invalid document ID');
if (!process.env.R2_GATEWAY_URL || !process.env.R2_GATEWAY_SECRET) throw new Error('R2 gateway is not configured');

const { app, store } = await createServer();
let migrated = 0;
let skipped = 0;
let failed = 0;
try {
  await store.waitForIdle();
  const ids = onlyId ? [onlyId] : [...store.documents.keys()].sort();
  for (const id of ids) {
    const record = store.getRecord(id);
    if (!record || record.manifest.status !== 'ready' || record.storageProvider === 'r2') {
      skipped += 1;
      continue;
    }
    try {
      if (await store.migrateLocalDocument(id)) migrated += 1;
      else skipped += 1;
    } catch {
      failed += 1;
      process.stderr.write(`R2 migration failed for document ${id}; local files remain.\n`);
    }
  }
  process.stdout.write(JSON.stringify({ migrated, skipped, failed }) + '\n');
  if (failed) process.exitCode = 1;
} finally {
  await app.close();
}
