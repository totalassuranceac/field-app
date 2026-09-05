# Building Field App from either of your X accounts (Grok Build)

You’re the only builder. GitHub is the code. The briefing is the Slack canvas (Goals + status), not commit messages. Either Grok login uses the same folder.

**Repo (private):** https://github.com/totalassuranceac/field-app  
**Local folder (this PC):** `C:\grok\fueltracker`  
**Live app:** Cloudflare Worker `total-assurance-fleet` (secrets stay on Cloudflare, not GitHub)

---

## Mental model

| What | Where it lives |
|------|----------------|
| Source code | GitHub `main` |
| Secrets (API keys, ST, OAuth) | Cloudflare + local `.dev.vars` (never commit) |
| Database data | Cloudflare D1 (export backups separately if needed) |
| Grok chat history | Per X/Grok login (sessions don’t always transfer between accounts) |

Switching **X accounts** only changes which Grok chat you’re in.  
The **code** is always “whatever is on GitHub + this folder.”

---

## Habit that keeps both accounts in sync

### End of a session (any account)

```powershell
cd C:\grok\fueltracker
git add PATHS-TO-REAL-FILES-ONLY
git status
git commit -m "Describe what you finished"
git push
```

If nothing to commit, still:

```powershell
git push
```

### Start of a session (other account or next day)

1. Open Grok Build (signed into whichever X account you’re using).
2. Open this project folder: `C:\grok\fueltracker`  
   (or clone the repo if you’re on another machine).
3. Pull latest:

```powershell
cd C:\grok\fueltracker
git pull
```

4. Tell Grok something like:  
   **“Continue Field App from GitHub main. Pull if needed. Don’t commit secrets.”**

That’s it — both accounts build on the same tree.

---

## Same PC, two X accounts

1. Use **one** project folder only: `C:\grok\fueltracker` (don’t keep two copies).
2. Sign into Grok with account A or B as needed (`grok login` / browser sign-in).
3. Always **push before you stop**, **pull when you start**.
4. Grok sessions (chat history) may be separate per login — that’s fine; the **repo** has the real work.

Optional: keep a short note in the last commit message so the next chat knows where you left off.

---

## Second PC / laptop

```powershell
git clone https://github.com/totalassuranceac/field-app.git
cd field-app
npm install
npx wrangler login
```

Then same pull / build / push habit.  
Deploy only after `wrangler login` to the Total Assurance Cloudflare account.

---

## What to never put in GitHub

- `.dev.vars`, `.env`
- Cloudflare secrets, ServiceTitan keys, Google OAuth secrets  
- GPS dumps, personal receipt photos you don’t want public to collaborators

These are already in `.gitignore` where possible.

---

## If Grok can’t see Git

Git is installed at:

`C:\Program Files\Git\bin\git.exe`

If `git` isn’t found in PATH, use the full path or re-open the terminal after installing Git.

---

## Invite only if you get a second human (or second GitHub user)

Repo → **Settings → Collaborators** → add their GitHub username.  
For **only your two X accounts**, you don’t need two GitHub users — one GitHub (`totalassuranceac`) + pull/push from any machine is enough.


Never git add -A. Commit only real files. Briefing is the Slack canvas, not commits.
