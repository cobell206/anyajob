// src/lambda.js
// AWS Lambda entrypoint for the web app (M4, see SERVERLESS-TRANSITION.md).
// Wraps the existing Express `app` with serverless-http so every route works
// unchanged behind an API Gateway HTTP API — a "lambdalith". No route rewrites.
//
// Auth is the gateway's job: the HTTP API route uses AWS_IAM authorization
// (decision D1), so there is no app-level auth middleware here.
//
// Importing ./server.js does NOT bind a port — server.js only calls
// app.listen when run directly (the isMain guard). Here we drive `app`
// through the adapter instead.

import serverless from 'serverless-http';
import { app } from './server.js';

// API Gateway can only carry binary response bodies as base64 with
// isBase64Encoded: true. serverless-http does that automatically, but ONLY for
// content-types it's told are binary — otherwise a PDF comes back corrupted as
// UTF-8. Document downloads (src/routes/documents.js, profile.js) stream PDFs,
// so those types must be listed. The M4 parity gate byte-compares a real PDF
// download to prove this is right.
export const handler = serverless(app, {
  binary: ['application/pdf', 'application/octet-stream'],
});
