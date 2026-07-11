// src/worker.js
// Background scoring worker (M4.5, see SERVERLESS-TRANSITION.md). A second
// Lambda off the SAME code asset, invoked asynchronously (InvocationType:Event)
// by the web Lambda's POST /resume/feedback so the ~54s Claude call finishes
// outside API Gateway's 30s cap. It runs the scoring, which persists the result
// (status:'done') to the S3 documents index; the client polls GET for it. On
// failure it records status:'error' so the poller stops with a message.
//
// Not an HTTP handler — the event is a plain job object: { job, lens }.

import { generateResumeFeedback, markResumeFeedbackError } from './feedback.js';
import { createLogger } from './log.js';

const log = createLogger('worker');

export const handler = async (event = {}) => {
  const { job, lens = 'law-school' } = event;
  log.info({ job, lens }, 'scoring worker invoked');

  if (job !== 'resume-feedback') {
    log.warn({ job }, 'unknown job type — ignoring');
    return { ok: false, reason: 'unknown-job' };
  }

  try {
    const result = await generateResumeFeedback({ lens });
    if (result?.error) {
      // generateResumeFeedback returns {error} (e.g. parse/extract failure)
      // WITHOUT persisting, so record a terminal error for the poller.
      await markResumeFeedbackError(lens, result.error);
      log.error({ lens, error: result.error }, 'scoring failed (soft error)');
      return { ok: false, reason: result.error };
    }
    log.info({ lens }, 'scoring complete → persisted');
    return { ok: true };
  } catch (err) {
    await markResumeFeedbackError(lens, err.message);
    log.error({ lens, err: err.message }, 'scoring threw');
    return { ok: false, reason: err.message };
  }
};
