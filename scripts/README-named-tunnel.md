# Named camera tunnel (stable URL)

## Why authorize failed

`totalassuranceac.com` is on a Cloudflare account that requires:

**Permission: Cloudflare One Connector → cloudflared Write**

If your login is only a limited member (or the zone is owned by another admin, e.g. David.johnson@…), the **Authorize** button fails.

## Fix authorize (zone admin does this once)

1. Sign into Cloudflare as an **Administrator / Super Admin** on the account that owns `totalassuranceac.com`.
2. On the shop PC, run:
   ```bat
   C:\ProgramData\TotalAssurance\nvr-tunnel\cloudflared.exe tunnel login
   ```
3. In the browser: select **totalassuranceac.com** → **Authorize**.
4. Confirm this file exists:
   ```
   %USERPROFILE%\.cloudflared\cert.pem
   ```
5. Run as Admin:
   ```bat
   C:\grok\fueltracker\scripts\setup-named-nvr-tunnel.bat
   ```
   That creates tunnel `ta-nvr` and DNS `nvr.totalassuranceac.com`.

## Until named tunnel works

Quick tunnels (`*.trycloudflare.com`) still work. Scheduled task **TA-NVR-UrlSync** re-points Field App every 2 minutes after reboot.

Manual sync anytime:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File C:\grok\fueltracker\scripts\sync-camera-tunnel-url.ps1
```
