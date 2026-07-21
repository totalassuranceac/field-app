# Put Field App on private GitHub

Use a **private** repo so only people you invite can see the code.  
**Do not** put GitHub passwords in chat or in scripts. Use a **Personal Access Token** or **GitHub Desktop**.

---

## Option A — GitHub Desktop (easiest)

1. Install [GitHub Desktop](https://desktop.github.com/) and sign in to the account that will **own** the private repo (e.g. `totalassuranceac` or your personal account).
2. **File → Add local repository** → `C:\grok\fueltracker`  
   - If it says “not a git repository”, choose **create a repository** there.
3. Commit all current files with a message like:  
   `Total Assurance Fleet — production snapshot`
4. **Publish repository**  
   - Name: `field-app` (or `fleet-tracker`)  
   - Keep **Keep this code private** checked  
   - Publish

### On another account / PC

1. Sign into GitHub Desktop with the **other** account  
   **or** have the owner invite that account: Repo → **Settings → Collaborators → Add people**
2. **File → Clone repository** → pick the private repo  
3. Or in PowerShell after Git is installed:

```powershell
git clone https://github.com/<OWNER>/<REPO>.git
cd <REPO>
npm install
npx wrangler login
npm run deploy
```

---

## Option B — Command line

### 1) Install Git (one time)

https://git-scm.com/download/win — install, then **restart** the terminal.

### 2) Create a private empty repo on GitHub

1. https://github.com/new  
2. Name: `field-app`  
3. **Private**  
4. **Do not** add README / .gitignore / license (you already have the project)  
5. Create repository  

### 3) Personal Access Token (instead of password)

1. https://github.com/settings/tokens → **Generate new token (classic)**  
2. Name: `fleet-tracker-pc`  
3. Scope: **repo**  
4. Generate → copy once into a password manager  

### 4) Push this folder

```powershell
cd C:\grok\fueltracker

git init
git add .
git status
git commit -m "Total Assurance Fleet — production snapshot"

git branch -M main
git remote add origin https://github.com/<OWNER>/field-app.git
git push -u origin main
```

When prompted:

- **Username:** your GitHub username  
- **Password:** paste the **token** (not your GitHub password)

---

## Invite another account to continue work

1. Open the private repo on GitHub  
2. **Settings → Collaborators** (or **Manage access**)  
3. **Add people** → their GitHub username / email  
4. They accept the invite, then **clone** the repo on their machine  

They do **not** need your Cloudflare login unless you also want them deploying; for deploy they need:

- Collaborator on the repo  
- Cloudflare access to the Total Assurance account (or you deploy from this PC)

---

## What stays out of GitHub

Already covered by `.gitignore` where possible:

| Keep off GitHub | Where it lives instead |
|-----------------|-------------------------|
| `.dev.vars` / `.env` | Local only |
| ServiceTitan / Google secrets | Cloudflare Worker secrets |
| `node_modules/`, `dist/`, `.wrangler/` | Rebuilt with `npm install` / `npm run build` |
| Live GPS dumps | Local / ignored |

Worker secrets stay on **Cloudflare** (`npx wrangler secret put …`).  
**GitHub holds code. Weekly D1 SQL exports hold data** (see `SAVE-THIS.md`).

---

## After clone — run the app

```powershell
cd fleet-tracker   # or whatever folder you cloned into
npm install
npx wrangler login
# Account ID (already in wrangler.toml if you keep it):
# f6da342467e60df683731c55dfc0e7b4
npm run deploy
```

Database and secrets usually already exist on the same Cloudflare Worker; you only re-add secrets if you create a **new** Worker.

---

## Quick recovery later

```powershell
git clone https://github.com/<OWNER>/field-app.git
cd field-app
npm install
npx wrangler login
npm run build
npx wrangler deploy
```
