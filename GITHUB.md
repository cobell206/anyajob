# GitHub setup

How to put this project on GitHub and (optionally) wire up push-to-deploy.

## 1. Create the repo (private)

The repo MUST be private — `data/preferences.json.example` has placeholders, but you'll likely also want to commit decisions, notes, and history that you don't want public. More importantly, the `.gitignore` only protects against accidental commits if you're disciplined; private is the safety net.

```bash
# In the project directory on your laptop:
git init
git add .
git commit -m "initial commit"

# Create a private repo on github.com/new, then:
git remote add origin git@github.com:<your-github-user>/anyajob.git
git branch -M main
git push -u origin main
```

Verify your `.gitignore` worked — these files should NOT appear in your first commit:
- `.env`
- `data/preferences.json` (with her real info)
- `data/listings.json`, `feedback.json`, etc.
- `node_modules/`
- `data/documents/` (her actual resumes)

```bash
git ls-files | grep -E '(\.env|data/(listings|feedback|preferences\.json|documents/))' && echo "LEAK!" || echo "OK"
```

## 2. Clone on the EC2 instance

```bash
ssh ubuntu@<your-ec2-ip>

# Set up an SSH key for the EC2 → GitHub direction (read-only deploy key)
ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub
# Copy the output, add it to GitHub: repo → Settings → Deploy keys → Add (read-only is fine)

# Tell SSH to use this key for github.com
cat >> ~/.ssh/config <<EOF
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config

# Now clone
cd ~
git clone git@github.com:<your-github-user>/anyajob.git anyajob
cd anyajob

# Run setup
./setup.sh

# Configure secrets
cp .env.example .env
nano .env                          # add Anthropic API key, AWS region, NOTIFY_FROM, etc.
nano data/preferences.json         # add her actual profile

# Restore data if you have a backup
./scripts/restore.sh

# Start it
sudo systemctl start anyajob
sudo systemctl status anyajob
```

## 3. Optional: push-to-deploy via GitHub Actions

This makes `git push origin main` from your laptop automatically deploy to EC2. Skip this if you'd rather `ssh ec2; cd anyajob; git pull; sudo systemctl restart anyajob` manually — that works fine too.

### Generate a deploy SSH key (laptop → EC2)

This is a separate key from your personal `~/.ssh/id_*` — it lives in GitHub Actions secrets and only authorizes pushing-to-deploy.

```bash
# On your laptop:
ssh-keygen -t ed25519 -f /tmp/anyajob_deploy -N "" -C "github-actions-deploy"

# The PUBLIC key (.pub) goes onto EC2:
cat /tmp/anyajob_deploy.pub
# SSH into EC2, append to ~/.ssh/authorized_keys:
ssh ubuntu@<your-ec2-ip>
echo "PASTE_PUBLIC_KEY_HERE" >> ~/.ssh/authorized_keys
exit

# The PRIVATE key (no extension) goes into GitHub Actions secrets:
cat /tmp/anyajob_deploy
# Copy the entire output (BEGIN/END lines included)

# THEN delete it from your laptop:
shred -u /tmp/anyajob_deploy /tmp/anyajob_deploy.pub
```

### Add GitHub Actions secrets

Repo → Settings → Secrets and variables → Actions → New repository secret. Add these four:

| Secret name | Value | Example |
|---|---|---|
| `EC2_SSH_KEY` | The private key contents | `-----BEGIN OPENSSH PRIVATE KEY-----...` |
| `EC2_HOST` | EC2 public IP or hostname | `52.12.345.67` |
| `EC2_USER` | SSH user on EC2 | `ubuntu` |
| `REPO_PATH` | Absolute path on EC2 | `/home/ubuntu/anyajob` |

### Allow EC2 sudo for systemctl restart (passwordless)

The deploy workflow runs `sudo systemctl restart anyajob`. By default sudo asks for a password — we need to allow this one specific command without one.

```bash
# On EC2:
sudo visudo -f /etc/sudoers.d/anyajob-deploy
```

Paste:
```
ubuntu ALL=(root) NOPASSWD: /bin/systemctl restart anyajob, /bin/systemctl status anyajob
```

(Replace `ubuntu` with `EC2_USER` value.)

Save. This grants only the two commands needed for deploy, nothing else.

### Test it

```bash
# On your laptop:
echo "# test" >> NOTES.md
git add NOTES.md
git commit -m "trigger deploy"
git push
```

Open the Actions tab on GitHub. You should see the workflow running. Within 30 seconds it should report "✓ Service is running."

If it fails:
- "Permission denied (publickey)" → public key not added to `authorized_keys` on EC2
- "sudo: a password is required" → sudoers file not configured correctly
- "Service failed to start" → SSH in and check `journalctl -u anyajob -n 50`

## 4. Day-to-day workflow

After setup, your loop is:

```bash
# Edit on laptop
nano src/server.js

# Test locally if you want
npm start

# Push to deploy
git add -A
git commit -m "tweak rate limiter"
git push

# GitHub Action runs automatically; ~20s later EC2 has the new code.
```

If you skip GitHub Actions and prefer manual:

```bash
# After pushing from your laptop:
ssh ubuntu@<your-ec2-ip>
cd anyajob
git pull
sudo systemctl restart anyajob
```

## 5. Rolling back

```bash
# On EC2:
cd ~/anyajob
git log --oneline -10                # see recent commits
git reset --hard <commit-sha>        # roll back to a known-good one
sudo systemctl restart anyajob

# Then on your laptop, undo the bad commit:
git revert <bad-sha>
git push
```

Or use the GitHub UI: the Actions tab has a "Re-run jobs" button on past successful deploys, which redeploys whatever was at that commit.

## 6. Branches?

For a one-person project, working directly on `main` is fine. If you want a safety net:

```bash
# Make changes on a branch
git checkout -b experiment
# ... edit, commit ...
git push -u origin experiment

# Deploys ONLY happen on main (per the workflow), so the branch is safe to test
# When ready, merge:
git checkout main
git merge experiment
git push        # this triggers the deploy
```

## What's NOT in version control

These live on EC2 only and are never committed:
- `.env` — API keys, secrets
- `data/preferences.json` — her actual profile
- `data/listings.json`, `feedback.json`, `seen.json` — runtime state
- `data/documents/` — uploaded resumes and cover letters
- `data/notifications.json` — email send log
- `*.log` — runtime logs

These are protected by:
1. `.gitignore` (won't accidentally commit)
2. Private repo (even if `.gitignore` fails, only you can see it)
3. Nightly S3 backup (if EC2 dies, you can restore them via `restore.sh`)

That's three layers of defense for sensitive data.
