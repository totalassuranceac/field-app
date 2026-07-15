# Put Fleet Tracker on GitHub (safe way)

**Do not use your GitHub account password with git.** GitHub blocks that.  
Use a **Personal Access Token** or **GitHub Desktop** / browser login.

---

## 1) Secure your account first

You shared a password in chat. Treat it as compromised:

1. Go to https://github.com/settings/security  
2. **Change password**  
3. Turn on **two-factor authentication (2FA)**  

Username: `totalassuranceac`

---

## 2) Install tools (one-time)

1. **Git for Windows:** https://git-scm.com/download/win  
2. Optional (easier): **GitHub Desktop:** https://desktop.github.com/  

Restart the terminal after install.

---

## 3) Create a private repo on GitHub

1. Sign in as **totalassuranceac**  
2. https://github.com/new  
3. Repository name: `fleet-tracker` (or similar)  
4. Visibility: **Private**  
5. Do **not** add README/license if you will push an existing folder  
6. Create repository  

---

## 4A) Push with GitHub Desktop (easiest)

1. Open GitHub Desktop  
2. File → Add local repository → choose `C:\grok\fueltracker`  
   - If asked to create a repo, create it  
3. Publish repository → choose account **totalassuranceac** → keep **Private**  
4. Done  

---

## 4B) Push with command line

### Create a Personal Access Token

1. https://github.com/settings/tokens  
2. **Generate new token (classic)**  
3. Name: `fleet-tracker-pc`  
4. Scopes: check **repo**  
5. Generate → **copy the token once** (like a password; store in a password manager)

### In PowerShell

```powershell
cd C:\grok\fueltracker

git init
git add .
git status
git commit -m "Total Assurance Fleet Tracker - production snapshot"

git branch -M main
git remote add origin https://github.com/totalassuranceac/fleet-tracker.git
git push -u origin main
```

When Git asks for:

- **Username:** `totalassuranceac`  
- **Password:** paste the **token**, not your GitHub password  

---

## 5) What not to put on GitHub

Already ignored via `.gitignore` where possible:

- `.dev.vars`  
- passwords / API keys  
- `.wrangler` local state  

Worker secrets stay only on **Cloudflare** (`wrangler secret put`).

---

## 6) After it’s on GitHub

- Bookmarks: private repo URL  
- Clone on another PC if this one dies  
- Still keep weekly **D1 SQL exports** (see `SAVE-THIS.md`) — GitHub holds **code**, not always full live data  

---

## Quick recovery later

```powershell
git clone https://github.com/totalassuranceac/fleet-tracker.git
cd fleet-tracker
npm install
npx wrangler login
$env:CLOUDFLARE_ACCOUNT_ID = "f6da342467e60df683731c55dfc0e7b4"
npm run build
npx wrangler deploy
```

Cloudflare secrets usually already exist; no need to re-enter unless you create a new Worker.
