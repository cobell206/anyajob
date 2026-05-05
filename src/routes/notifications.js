// src/routes/notifications.js
// Email preview + test-send + send log. Wraps src/notify.js so the
// settings UI can let her preview each template, send a test to herself,
// and review what was actually sent.

import { Router } from 'express';
import { readJson } from '../io.js';
import {
  previewMorning,
  previewMorningUrgent,
  previewWeekly,
  sendEmail,
  resolveRecipients,
} from '../notify.js';

const router = Router();

const PREVIEWS = {
  morning: previewMorning,
  urgent: previewMorningUrgent,
  weekly: previewWeekly,
};

// Preview rendered email HTML for tuning. ?kind=morning|urgent|weekly
router.get('/preview/:kind', (req, res) => {
  const fn = PREVIEWS[req.params.kind];
  if (!fn) return res.status(404).json({ error: 'Unknown preview kind' });
  const { subject, html } = fn();
  res.json({ subject, html });
});

// Send a test email. Uses the preview content with a [TEST] subject prefix.
// If `to` is in the request body, send there; otherwise resolve from prefs.
router.post('/send-test', async (req, res) => {
  try {
    const { kind, to } = req.body;
    const fn = PREVIEWS[kind];
    if (!fn) return res.status(400).json({ error: 'Unknown kind' });
    const prefs = await readJson('preferences.json');
    let recipients;
    if (to) {
      recipients = (Array.isArray(to) ? to : [to])
        .map((s) => String(s || '').trim())
        .filter(Boolean);
    } else {
      recipients = resolveRecipients(prefs);
    }
    if (recipients.length === 0) return res.status(400).json({ error: 'No recipient(s) set' });
    const { subject, html } = fn();
    const result = await sendEmail({ to: recipients, subject: '[TEST] ' + subject, html });
    res.json({ ok: true, messageId: result.messageId, sentTo: recipients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/log', async (req, res) => {
  try {
    const log = await readJson('notifications.json').catch(() => ({ sent: [] }));
    res.json(log);
  } catch {
    res.json({ sent: [] });
  }
});

export default router;
