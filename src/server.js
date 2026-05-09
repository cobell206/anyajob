// restart trigger
// src/server.js
// Bootstrap. All route logic lives in src/routes/*.js — this file just
// composes them. Designed to sit behind Cloudflare Access.

import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import listingsRouter from './routes/listings.js';
import feedbackRouter from './routes/feedback.js';
import preferencesRouter from './routes/preferences.js';
import summariesRouter from './routes/summaries.js';
import pasteRouter from './routes/paste.js';
import documentsRouter from './routes/documents.js';
import profileRouter from './routes/profile.js';
import notificationsRouter from './routes/notifications.js';
import sourcesRouter from './routes/sources.js';
import discoveriesRouter from './routes/discoveries.js';
import logsRouter from './routes/logs.js';
import diagnosticRouter from './routes/diagnostic.js';
import adminRouter from './routes/admin.js';
import { createLogger } from './log.js';

const log = createLogger('server');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const app = express();
// Behind Cloudflare Tunnel — trust exactly one upstream proxy so
// express-rate-limit reads the real client IP from X-Forwarded-For instead
// of seeing every request as coming from 127.0.0.1.
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(ROOT, 'public'), {
  // `path` is the resolved file path on disk (express.static's second
  // setHeaders arg). Don't read res.req.path here — that's the URL path,
  // and for `/` it's `/` (not `/index.html`), which would mis-classify
  // the served index.html as a non-HTML asset and apply the immutable
  // long-cache header. With Cloudflare in front, that pins stale HTML
  // at the edge for a year.
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// Global API rate limit. Discovery has its own tighter limit on top of this.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
});
app.use('/api/', apiLimiter);

// Listings, stats, and spend share a router because they all read listings.json.
// Mounted at root so existing URLs like /api/today and /api/listings keep working.
app.use('/api', listingsRouter);

app.use('/api/feedback', feedbackRouter);
app.use('/api/preferences', preferencesRouter);
app.use('/api/summaries', summariesRouter);
app.use('/api/score-paste', pasteRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/profile', profileRouter);
app.use('/api/notify', notificationsRouter);
app.use('/api/sources', sourcesRouter);
app.use('/api/discoveries', discoveriesRouter);
app.use('/api', adminRouter);

// Debugging endpoints. Output is redacted server-side (see src/redact.js).
// Cloudflare Access already gates these like the rest of /api/.
app.use('/api/logs', logsRouter);
app.use('/api/diagnostic', diagnosticRouter);

// Final catch-all error handler — converts thrown errors into clean JSON
// responses instead of leaking stack traces. Routes that handle errors
// explicitly (most of them) bypass this.
app.use('/api', (err, req, res, next) => {
  log.error({ err, method: req.method, path: req.path }, 'api error');
  res.status(500).json({ error: err.message || 'Internal error' });
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  log.info({ port, url: `http://localhost:${port}` }, 'server listening');
});
