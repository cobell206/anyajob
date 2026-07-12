# AnyaJob — Deploy Tonight

> ⚠️ **Historical — pre-serverless.** This one-night checklist provisioned the
> original EC2 host + Cloudflare Tunnel + SES, all retired in the 2026-07 move
> to Lambda + API Gateway + S3. Not current. See
> [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`README.md`](README.md). Kept for
> historical reference only.

Step-by-step checklist. Do these in order. ~60–75 min total, then submit the SES request before bed and emails will be live in the morning.

**Login:** Cloudflare Access handles it. When anyone visits the URL, they see a Cloudflare login page, enter their email, and get a one-time PIN. You whitelist which emails are allowed (hers + yours). No passwords, no app auth code. Free for personal use.

---

## Step 1 — Anthropic API key (5 min)

1. Go to [console.anthropic.com](https://console.anthropic.com) and sign in (this is separate from your Claude subscription)
2. Add a payment method under Billing
3. Buy $10 in credits to start
4. Go to **Settings → Limits** → set a monthly hard cap of $20
5. Set email alerts at 50% and 80%
6. Go to **API Keys** → Create key → name it `anyajob-prod`
7. **Copy the key now** — you won't see it again. Paste it somewhere temporary.

---

## Step 2 — Domain via Cloudflare (10 min)

1. Go to [cloudflare.com/products/registrar](https://cloudflare.com/products/registrar)
2. Search for a domain — `.app` or `.xyz` runs ~$10/year. Something like `anyajob.app` or `anyajobs.app`
3. Buy it — DNS is automatically on Cloudflare, which saves a step later
4. After purchase, go to [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → set up **Zero Trust** if prompted (free, no card needed for under 50 users)

> **Note your domain** — you'll use it in several steps below. Replace `yourdomain.app` with the real one throughout this doc.

---

## Step 3 — GitHub repo (5 min)

1. Go to [github.com/new](https://github.com/new)
2. Create a **private** repo named `anyajob`
3. On your laptop, in the `anyaJob` folder:

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin git@github.com:YOUR_USERNAME/anyajob.git
git branch -M main
git push -u origin main
```

4. Verify the push worked — check the repo on GitHub

---

## Step 4 — Launch EC2 (10 min)

1. Go to [AWS Console → EC2](https://console.aws.amazon.com/ec2) → **Launch Instance**
2. Fill in:
   - **Name:** `anyajob`
   - **AMI:** Ubuntu Server 22.04 LTS
   - **Instance type:** `t3.micro` (free tier eligible)
   - **Key pair:** Create new → name it `anyajob` → download the `.pem` file → save it somewhere safe (e.g. `~/.ssh/anyajob.pem`)
3. Under **Network settings** → Edit → create a new security group:
   - Add rule: SSH, port 22, source = **My IP** only
   - **Do not add port 80 or 3000** — Cloudflare Tunnel handles all ingress
4. **Storage:** 20 GB gp3 (free tier includes 30 GB)
5. Click **Launch instance**
6. Wait ~60 seconds, then find the **Public IPv4 address** on the instance page. Write it down.

SSH in:

```bash
chmod 400 ~/.ssh/anyajob.pem
ssh -i ~/.ssh/anyajob.pem ubuntu@<EC2-PUBLIC-IP>
```

If it connects, you're in. Leave this terminal open.

---

## Step 5 — Set up a GitHub deploy key (5 min)

This lets EC2 pull from your private GitHub repo.

On the EC2 instance:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub
```

Copy the output (starts with `ssh-ed25519`).

On GitHub:
1. Go to your `anyajob` repo → **Settings → Deploy keys → Add deploy key**
2. Title: `ec2`, paste the key, **Read-only** is fine
3. Click **Add key**

Back on EC2:

```bash
cat >> ~/.ssh/config <<EOF
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
```

Test it:

```bash
ssh -T git@github.com
# Should say: Hi YOUR_USERNAME! You've successfully authenticated...
```

---

## Step 6 — Clone and provision (10 min)

On EC2:

```bash
cd ~
git clone git@github.com:YOUR_USERNAME/anyajob.git
cd anyajob
./setup.sh
```

`setup.sh` installs Node, LibreOffice, AWS CLI, cloudflared, creates the systemd service, and installs cron entries. Takes 3–5 min. Watch for errors — if it fails, re-run it (it's idempotent).

Verify when done:

```bash
node --version       # should say v20.x
cloudflared --version
crontab -l           # should show 3 anyajob entries
```

---

## Step 7 — Configure .env and preferences (10 min)

On EC2, still in `~/anyajob`:

```bash
cp .env.example .env
nano .env
```

Fill in these fields (leave others as-is for now):

```
ANTHROPIC_API_KEY=sk-ant-...        ← your key from Step 1
APP_ENV=production
AWS_REGION=us-east-1
NOTIFY_FROM="AnyaJob <alerts@yourdomain.app>"
PUBLIC_URL=https://jobs.yourdomain.app
BACKUP_BUCKET=                      ← leave blank for now, add after S3 setup
```

Save and exit (`Ctrl+X`, `Y`, `Enter`).

Now set up her profile:

```bash
cp data/preferences.example.json data/preferences.json
nano data/preferences.json
```

Fill in the real values — name, current role, GPA, school, target law schools, interests, and the notification email address. This is what Claude uses to score listings, so the more accurate the better.

---

## Step 8 — Cloudflare Tunnel (10 min)

This connects EC2 to your domain without opening any firewall ports.

On EC2:

```bash
# Authenticate — this prints a URL, copy it, open it in your browser, log in to Cloudflare
cloudflared tunnel login

# Create the tunnel
cloudflared tunnel create anyajob
# Note the tunnel ID it prints — you'll need it below
```

Create the tunnel config:

```bash
mkdir -p ~/.cloudflared
nano ~/.cloudflared/config.yml
```

Paste (replace both placeholders):

```yaml
tunnel: <YOUR-TUNNEL-ID>
credentials-file: /home/ubuntu/.cloudflared/<YOUR-TUNNEL-ID>.json

ingress:
  - hostname: jobs.yourdomain.app
    service: http://localhost:3000
  - service: http_status:404
```

```bash
# Route DNS (adds a CNAME in Cloudflare automatically)
cloudflared tunnel route dns anyajob jobs.yourdomain.app

# Install and start as a service
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
sudo systemctl status cloudflared   # should say "active (running)"
```

---

## Step 9 — Cloudflare Access login gate (5 min)

This is the login screen. Only whitelisted emails can get in.

1. Go to [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → **Access → Applications → Add an application**
2. Choose **Self-hosted**
3. Fill in:
   - **Application name:** AnyaJob
   - **Session duration:** 24 hours
   - **Subdomain:** `jobs` / **Domain:** `yourdomain.app`
4. Click Next → **Add a policy**
   - Policy name: `Allow us`
   - Action: Allow
   - Include rule: **Emails** → add her email and your email
5. Save

Now visiting `https://jobs.yourdomain.app` will show a Cloudflare login screen. Anyone not on the list gets blocked.

---

## Step 10 — Start the app and test (5 min)

On EC2:

```bash
cd ~/anyajob

# Start the service
sudo systemctl start anyajob
sudo systemctl status anyajob    # should say "active (running)"

# Run the daily pipeline once manually to seed listings
npm run daily
# Watch the output — you should see sources scraping and listings being scored
# This takes 1-3 minutes
```

Then open `https://jobs.yourdomain.app` in your browser. You'll see the Cloudflare login screen — enter your email, get the PIN, and you should land on the listings page with today's results.

---

## Step 11 — Submit AWS SES request (5 min, then 12–24h wait)

This is what enables the morning emails. Submit before bed.

1. AWS Console → **SES (Simple Email Service)** — make sure you're in `us-east-1` (or whatever region you set in `.env`)
2. **Verified identities → Create identity → Domain** → enter `yourdomain.app`
3. Enable DKIM (default settings are fine)
4. SES gives you 3 CNAME records — go to Cloudflare DNS and add them **with the proxy turned OFF (gray cloud)**
5. Wait a few minutes, refresh SES — should show "Verified"
6. Go to **Account dashboard → Request production access**:
   - Mail type: Transactional
   - Website URL: `https://jobs.yourdomain.app`
   - Use case: "Personal job-search tracking app. Sends daily morning briefs and weekly digests to one recipient — the job applicant."
7. Submit. AWS typically approves in 12–24 hours via email.

While you wait: emails will fail silently, but everything else (scraping, scoring, UI) works fine.

---

## Step 12 — Wire up GitHub Actions push-to-deploy (15 min, optional but recommended)

After everything above is working, this makes `git push` auto-deploy to EC2.

**Generate a deploy key (on your laptop, not EC2):**

```bash
ssh-keygen -t ed25519 -f /tmp/anyajob_deploy -N "" -C "github-actions"
cat /tmp/anyajob_deploy.pub    # copy this
```

**On EC2:**

```bash
echo "PASTE_PUBLIC_KEY_HERE" >> ~/.ssh/authorized_keys

# Allow passwordless sudo for service restart only
sudo visudo -f /etc/sudoers.d/anyajob-deploy
```

In the editor, paste:

```
ubuntu ALL=(root) NOPASSWD: /bin/systemctl restart anyajob, /bin/systemctl status anyajob
```

**On GitHub → repo → Settings → Secrets → Actions → New secret** — add four secrets:

| Secret | Value |
|--------|-------|
| `EC2_SSH_KEY` | Contents of `/tmp/anyajob_deploy` (the private key, including BEGIN/END lines) |
| `EC2_HOST` | Your EC2 public IP |
| `EC2_USER` | `ubuntu` |
| `REPO_PATH` | `/home/ubuntu/anyajob` |

**Delete the key from your laptop:**

```bash
shred -u /tmp/anyajob_deploy /tmp/anyajob_deploy.pub
```

The `.github/workflows/deploy.yml` file is already in the repo. Push anything to main and the Actions tab will show the deploy running.

---

## Done — verification checklist

- [ ] `https://jobs.yourdomain.app` shows Cloudflare login
- [ ] After PIN, you see the listings page with scored roles
- [ ] `crontab -l` shows 3 anyajob cron entries
- [ ] `sudo systemctl status anyajob` shows active
- [ ] `sudo systemctl status cloudflared` shows active
- [ ] SES production access request submitted
- [ ] (After SES approval) `npm run test-email -- her@gmail.com` delivers successfully

---

## Morning after SES approval

```bash
# On EC2:
nano .env
# Add/confirm: NOTIFY_FROM and PUBLIC_URL are set

# Send a test email
npm run test-email -- her@gmail.com
```

She should get a "It works ✓" email. Once that lands, the morning cron at 6am ET will start delivering daily briefs automatically.

---

## Quick reference — useful commands

```bash
# Check app logs
sudo journalctl -u anyajob -f

# Restart after code change
sudo systemctl restart anyajob

# Run daily pipeline manually
npm run daily

# Check spend
cat data/spend.json

# Restore from S3 (if needed)
./scripts/restore.sh
```
