// scripts/test-email.js
// Send a test email to verify SES is configured correctly.
// Usage: npm run test-email -- her@example.com

import 'dotenv/config';
import { sendEmail } from '../src/notify.js';

const to = process.argv[2];
if (!to) {
  console.error('Usage: npm run test-email -- recipient@example.com');
  process.exit(1);
}

console.log(`Sending test email to ${to} from ${process.env.NOTIFY_FROM}...`);

const result = await sendEmail({
  to,
  subject: 'AnyaJob · Test email',
  html: `<!doctype html><html><body style="font-family:sans-serif;padding:20px">
    <h2 style="font-family:Georgia,serif">It works ✓</h2>
    <p>If you can read this, AWS SES is wired up correctly. You can now enable notifications in <code>data/preferences.json</code>.</p>
  </body></html>`,
});

console.log('Sent. Message ID:', result.messageId);
