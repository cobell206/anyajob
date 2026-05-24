# Deploy Guide: EC2 + Cloudflare Tunnel + Access

End-to-end setup, ~30-45 minutes if you've never done it before.

## Part 1: Anthropic API account (5 min)

1. Go to https://console.anthropic.com — sign in (separate from your Pro/Max subscription billing)
2. Add a payment method
3. Buy $10 in credits to start
4. **Set a monthly spend limit** — Settings → Limits → set to $20 as a hard cap
5. Set email alerts at 50% and 80% of cap
6. Generate an API key. Name it `job-tracker-prod`. Copy it — you'll paste into `.env` later.

## Part 2: Domain + Cloudflare (10 min)

1. If you don't have one, buy a cheap domain at cloudflare.com/products/registrar — `.xyz` or `.app` runs ~$10/year
2. If your domain is elsewhere, transfer DNS to Cloudflare (free) — change nameservers at your registrar
3. Go to Cloudflare Zero Trust dashboard (one.dash.cloudflare.com) — set up free Zero Trust if prompted (no card needed for personal use under 50 users)

## Part 3: EC2 instance (10 min)

1. AWS Console → EC2 → Launch Instance
2. Name: `job-tracker`
3. AMI: Ubuntu Server 24.04 LTS (Noble Numbat) — recommended. 26.04 also works on free tier; 24.04 is the safer LTS pick (supported through 2029, more battle-tested).
4. Instance type: `t3.micro` (free tier)
5. Key pair: create new, download `.pem`, save somewhere safe
6. Network: default VPC, default subnet
7. Security group — create new with these rules:
   - SSH (port 22) from **My IP** only — never `0.0.0.0/0`
   - That's it. **No port 80, no port 3000.** Cloudflare Tunnel handles ingress.
8. Storage: 20GB gp3 (free tier includes 30GB)
9. Launch

SSH in:

```bash
chmod 400 ~/Downloads/job-tracker.pem
ssh -i ~/Downloads/job-tracker.pem ubuntu@<your-ec2-public-ip>
```

## Part 4: Provision the EC2 instance (5 min)

The repo includes `setup.sh` which installs everything (Node, LibreOffice, pdftotext, AWS CLI, cloudflared), creates the systemd service, and installs cron entries. One command.

```bash
# Clone (see GITHUB.md for setting up the deploy key first)
cd ~
git clone git@github.com:<your-github-user>/anyajob.git
cd anyajob

# Run setup
./setup.sh

# Configure secrets
cp .env.example .env
nano .env                          # Anthropic API key, AWS region, NOTIFY_FROM, BACKUP_BUCKET
nano data/preferences.json         # her actual profile
```

The setup script is idempotent — re-run it anytime; flags `--skip-system`, `--skip-app`, `--no-cron` let you re-run partial steps.

### Verify the install
```bash
node --version          # v20.x
libreoffice --version   # 7.x
pdftotext -v            # any version
aws --version           # 2.x
cloudflared --version   # any version
crontab -l              # should show 3 anyajob entries
sudo systemctl status anyajob  # should show "loaded" (not started yet)
```

### S3 backup setup (one-time, in AWS console)

1. **S3 → Create bucket** — name it like `anyajob-backup-<random>`. Block all public access (default). Enable versioning. Region same as your EC2.
2. **IAM → Users → Add user** — name `anyajob-backup`, attach inline policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:PutObject", "s3:GetObject", "s3:ListBucket", "s3:DeleteObject"],
       "Resource": [
         "arn:aws:s3:::anyajob-backup-<random>",
         "arn:aws:s3:::anyajob-backup-<random>/*"
       ]
     }]
   }
   ```
3. Create access keys for the IAM user. On EC2:
   ```bash
   aws configure  # paste access key / secret / region
   ```
4. Set `BACKUP_BUCKET=s3://anyajob-backup-<random>/job-tracker` in `.env`
5. Test: `npm run backup` — should sync `data/` to S3.

## Part 5: Test the daily run (2 min)

```bash
cd ~/job-tracker
npm run daily
```

You should see logs from each source and listings being scored. If a source breaks, the others continue. Check `data/listings.json` afterward — it should have new entries.

Test the server:

```bash
npm start
# In another SSH session:
curl http://localhost:3000/api/today
```

Stop the test server with Ctrl+C.

## Part 6: Cloudflare Tunnel (10 min)

This is what lets you reach the EC2 instance from her phone without opening any public ports.

```bash
# Install cloudflared on EC2
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# Authenticate — this opens a URL, copy it to your laptop browser, log in to Cloudflare
cloudflared tunnel login

# Create the tunnel
cloudflared tunnel create job-tracker
# Note the tunnel ID it prints

# Create config
mkdir -p ~/.cloudflared
nano ~/.cloudflared/config.yml
```

Paste:

```yaml
tunnel: <YOUR_TUNNEL_ID>
credentials-file: /home/ubuntu/.cloudflared/<YOUR_TUNNEL_ID>.json

ingress:
  - hostname: jobs.anyalawgirly.com
    service: http://localhost:3000
  - service: http_status:404
```

```bash
# Route DNS
cloudflared tunnel route dns job-tracker jobs.anyalawgirly.com

# Run as a service
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

## Part 7: Cloudflare Access policy (5 min)

In Cloudflare Zero Trust dashboard:

1. Access → Applications → Add an application → Self-hosted
2. Application name: `Job Tracker`
3. Session duration: 24 hours
4. Application domain: `jobs` + `anyalawgirly.com`
5. Identity providers: enable "One-time PIN" (works without setup) and/or Google
6. Add policy: Name "Allow her and me", Action: Allow, Include: Emails: her email, your email
7. Save

Now visiting `jobs.anyalawgirly.com` shows a Cloudflare login page. After her email gets the one-time PIN (or Google login), she's in for 24 hours.

## Part 8: Start the service (1 min)

`setup.sh` already created the systemd unit and the cron entries. Start it:

```bash
sudo systemctl start anyajob
sudo systemctl status anyajob   # should show "active (running)"

# Cron entries are already installed; verify:
crontab -l
# You should see 3 entries marked with "anyajob managed entries"
```

The cron schedule is:

```cron
# Daily scrape + morning email at 6am ET (10am UTC)
0 10 * * * cd /home/ubuntu/anyajob && node src/daily.js >> daily.log 2>&1

# Discovery: find new sources Mon + Thu at 7am ET (11am UTC) — uses Claude web_search, ~$0.50/run
0 11 * * 1,4 cd /home/ubuntu/anyajob && node scripts/discover.js >> discover.log 2>&1

# Weekly digest Sunday 9am ET (1pm UTC)
0 13 * * 0 cd /home/ubuntu/anyajob && node scripts/weekly.js >> weekly.log 2>&1

# Nightly S3 backup at 2am ET (6am UTC)
0 6 * * * cd /home/ubuntu/anyajob && node scripts/backup.js >> backup.log 2>&1
```

To re-install or update them (e.g., after editing the script), re-run:

```bash
./setup.sh --skip-system --skip-app
```

## Part 9: First-time data check

Confirm the S3 backup ran:

```bash
aws s3 ls s3://anyajob-backup-<random>/job-tracker/
# Should show a date-stamped folder with feedback.json, listings.json, documents/, etc
```

## Part 10: AWS SES email setup (~24 hours including approval wait)

This is what enables the morning brief, closing-soon, and weekly digest emails. **Two stages**: verification (15 min) and production access (24-hour wait for approval).

### Stage 1: Verify your sending domain

1. AWS Console → SES (Simple Email Service) → make sure you're in the same region as your `AWS_REGION` env var (default `us-east-1`)
2. Verified identities → Create identity → Domain → enter `anyalawgirly.com`
3. Enable DKIM (default settings are fine — Easy DKIM with RSA_2048_BIT)
4. SES will give you 3 CNAME records to add to DNS
5. Since DNS is on Cloudflare: Cloudflare dashboard → your domain → DNS → add the 3 CNAMEs **with the proxy turned OFF (gray cloud)** — SES needs direct DNS, not proxied
6. Back in SES, refresh — should switch to "Verified" within a few minutes
7. Also create a verified sender identity for `alerts@anyalawgirly.com` (you don't need to set up a real mailbox — SES just needs to confirm you control the domain, which the domain verification already covers)

### Stage 2: Move out of SES sandbox

By default SES only lets you send to verified email addresses. To send to her arbitrary email:

1. SES → Account dashboard → Request production access
2. Mail type: Transactional
3. Website URL: your AnyaJob URL (`https://jobs.anyalawgirly.com`)
4. Use case description: "Personal job-search tracking app sending application reminder emails to one user (the applicant) — daily morning briefs, closing-soon alerts, and weekly digests for myself."
5. Acknowledge the AWS Acceptable Use Policy
6. Submit. Approval typically arrives in 12-24 hours via email.

### Stage 3: IAM permissions

The EC2 instance needs permission to call SES. Two options:

**Option A: IAM role attached to EC2 (cleanest)**
1. IAM → Roles → Create role → AWS service → EC2
2. Attach policy: `AmazonSESFullAccess` (or a custom policy with just `ses:SendEmail` and `ses:SendRawEmail`)
3. EC2 → your instance → Actions → Security → Modify IAM role → attach the new role
4. No keys in `.env` needed; SDK picks up credentials automatically

**Option B: Access key in .env (simpler if you already use access keys)**
Add to `.env`:
```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

### Stage 4: Configure and test

In `.env`:
```
AWS_REGION=us-east-1
NOTIFY_FROM="AnyaJob <alerts@anyalawgirly.com>"
PUBLIC_URL=https://jobs.anyalawgirly.com
```

In `data/preferences.json`:
```json
"notifications": {
  "recipient": "her@gmail.com",
  "morningEmail": true,
  "closingEmail": true,
  "weeklyEmail": true
}
```

Test:
```bash
cd ~/job-tracker
npm run test-email -- her@gmail.com
```

She should get a "It works ✓" email within a minute. If it fails, common issues:
- "Email address not verified" → still in sandbox, complete Stage 2
- "AccessDenied" → IAM role not attached, complete Stage 3
- Email lands in spam → DKIM didn't propagate. Wait 30 min and check Cloudflare CNAME records have proxy disabled (gray cloud)

### Stage 5: Preview emails

Visit `https://jobs.anyalawgirly.com/settings.html` and open the **Notifications** section to preview the three email templates and send tests. This is the safest way to tune copy before turning on the cron jobs.

## Verification checklist

- [ ] `https://jobs.anyalawgirly.com` shows Cloudflare Access login
- [ ] After login, you see "Today's Roles" page
- [ ] Cron is set: `crontab -l` shows daily + backup entries
- [ ] Service running: `systemctl status job-tracker`
- [ ] Tunnel running: `systemctl status cloudflared`
- [ ] EC2 security group only has SSH from your IP
- [ ] Anthropic dashboard shows a spend cap
- [ ] `data/preferences.json` has her real profile
- [ ] LibreOffice installed: `libreoffice --version`
- [ ] Document upload works: open a listing → upload a test PDF → preview opens
- [ ] DOCX preview works: upload a .docx → "Preview" button shows the converted PDF
- [ ] Resume vs JD scoring runs on resume upload (~5 sec delay, then alignment box appears)
- [ ] S3 backup ran: `aws s3 ls s3://your-bucket/job-tracker/`

## Troubleshooting

**"jobs.anyalawgirly.com" hangs or 502s** — Cloudflared can't reach localhost:3000. Check `systemctl status job-tracker` and `journalctl -u job-tracker -n 50`.

**Daily cron didn't run** — Check `daily.log` in the project dir. Cron's environment is minimal; if you see "command not found" for node, replace `/usr/bin/node` with the output of `which node`.

**API errors about credit** — Check console.anthropic.com → Usage. You may have hit your spend cap.

**Scrapers returning 0 listings** — The HTML scaffolds (Idealist, NYC Bar, PSJD) need their selectors filled in. Use Claude Code on your laptop: `cd src/sources && claude "fix idealist.js by inspecting the live page"`.

**DOCX preview shows nothing** — LibreOffice not installed or hung. Check `which libreoffice`, then test: `libreoffice --headless --convert-to pdf test.docx`. The first run can take 10+ seconds while it initializes its profile.

**Resume scoring returns "Could not extract text"** — `pdftotext` (poppler-utils) not installed for PDF resumes, or `mammoth` not installed for DOCX. Run `npm install` again, and for PDFs `sudo apt install -y poppler-utils`.

**S3 backup fails** — Run `aws s3 ls` to confirm credentials work. Check IAM policy allows the actions in `scripts/backup.js`.

## Reading logs

The app uses [pino](https://github.com/pinojs/pino) for structured logging. Every log line includes a `component` field (`daily`, `server`, `discover-cron`, `usajobs`, etc.) so you can filter by subsystem.

**The web server** (running under systemd) logs to journald:
```bash
sudo journalctl -u anyajob -n 100             # last 100 lines
sudo journalctl -u anyajob -f                  # follow live
sudo journalctl -u anyajob --since '1 hour ago' -p err   # errors only
sudo journalctl -u anyajob | grep '"component":"sources"' # one subsystem
```

**Cron jobs** log to `*.log` files in the project directory:
```bash
tail -f ~/anyajob/daily.log         # daily scrape + scoring
tail -f ~/anyajob/discover.log      # twice-weekly source discovery
tail -f ~/anyajob/weekly.log        # Sunday digest
tail -f ~/anyajob/backup.log        # nightly S3 sync
```

**Filtering JSON logs.** In production, logs are JSON. To pretty-print on demand:
```bash
tail -f daily.log | npx pino-pretty
```

**Tuning log volume.** Set in `.env`:
- `LOG_LEVEL=info` (default) — info, warn, error, fatal
- `LOG_LEVEL=debug` — adds debug for noisy local debugging
- `LOG_LEVEL=warn` — quieter, only warnings and errors
- `LOG_FORMAT=pretty` — color-coded output even in production (useful when SSH-tailing)
- `LOG_FORMAT=json` (default in production) — machine-readable JSON

**Future option: remote aggregation.** The pino setup is ready to add a transport like [Better Stack](https://betterstack.com/logs) (free tier, 1GB/month) for remote searchable logs. Add `@logtail/pino` to dependencies and a target in `src/log.js`'s `transport.targets` array. Until then, SSH + journalctl is enough.

## Remote log access (laptop CLI)

For debugging without SSHing in, two HTTP endpoints expose redacted logs over the same Cloudflare Access auth as the rest of the API:

- `GET /api/logs/sources` — list available log files
- `GET /api/logs/:source?since=1h&level=warn&limit=500` — read recent lines
- `GET /api/diagnostic` — curated state snapshot (sources, listings counts, spend, recent log tails)
- `GET /api/diagnostic?format=text` — same bundle as plain text (easier to paste into a chat)

All output passes through `src/redact.js` server-side. API keys, AWS keys, GitHub tokens, JWTs, email addresses, file paths, and long opaque tokens are stripped.

**Setup the laptop CLI** (`bin/anyajob-logs`):

1. Create a Cloudflare Access service token in the Zero Trust dashboard:
   - Zero Trust → Access → Service Auth → Create token
   - Save the Client ID and Client Secret
2. Edit your Access policy for `jobs.anyalawgirly.com` to include the service token (Include rule → Service Auth → your token)
3. Copy `bin/anyajob-logs` to `/usr/local/bin/` (or anywhere on your PATH)
4. Set environment variables in `~/.zshrc` or `~/.bashrc`:
   ```bash
   export ANYAJOB_HOST=https://jobs.anyalawgirly.com
   export ANYAJOB_CF_CLIENT_ID=<service-token-id>
   export ANYAJOB_CF_CLIENT_SECRET=<service-token-secret>
   ```

**Usage:**

```bash
anyajob-logs                        # diagnostic bundle (text format)
anyajob-logs --json                 # diagnostic bundle (JSON)
anyajob-logs daily                  # last 500 lines of daily.log
anyajob-logs daily 1h               # last hour of daily.log
anyajob-logs discover --error       # only errors from discover.log
anyajob-logs sources                # list available log files
anyajob-logs --copy daily 1h        # fetch + copy to clipboard (pbcopy/xclip)
```

For sharing with Claude during debugging, `anyajob-logs --copy` puts a redacted bundle on your clipboard ready to paste.
