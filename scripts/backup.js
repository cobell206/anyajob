// scripts/backup.js
// Nightly backup of data/ to S3. Uses `aws s3 sync` shelled out.
// Configure via env: BACKUP_BUCKET=s3://my-bucket/job-tracker
// Run via cron: 0 11 * * * cd /home/ubuntu/job-tracker && npm run backup

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createLogger } from '../src/log.js';

const log = createLogger('backup');
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

const bucket = process.env.BACKUP_BUCKET;
if (!bucket) {
  log.fatal('BACKUP_BUCKET not set in .env (e.g., s3://my-bucket/job-tracker)');
  process.exit(1);
}

const date = new Date().toISOString().slice(0, 10);
const dest = `${bucket.replace(/\/$/, '')}/${date}`;

log.info({ src: DATA_DIR, dest }, 'syncing');

const proc = spawn('aws', ['s3', 'sync', DATA_DIR, dest, '--exclude', '*.log'], {
  stdio: 'inherit',
});

proc.on('close', (code) => {
  if (code === 0) {
    log.info('backup complete');
  } else {
    log.error({ exitCode: code }, 'aws s3 sync failed');
    process.exit(code);
  }
});
