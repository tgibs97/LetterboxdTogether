# Deployment Guide — TrueNAS SCALE + Cloudflare

## Overview

| Piece | What it does |
|---|---|
| GitHub Actions | Builds a Docker image and pushes it to GHCR on every push to `main` |
| TrueNAS SCALE | Runs the app via Docker Compose over SSH |
| Watchtower | Polls GHCR every 5 min and auto-restarts the app when a new image is available |
| Cloudflare Tunnel | Exposes the app to the internet without opening any ports on your router |
| Cloudflare Access | Puts a login screen in front of the tunnel |

---

## Step 1 — Push to GitHub and let Actions build the first image

1. Commit everything and push to `main`.
2. Go to **Actions** on your GitHub repo and wait for the `Build and push Docker image` workflow to go green.
3. Go to **Packages** on your GitHub profile — you should see `letterboxdtogether` listed.
4. By default the package is **private**. Either:
   - Make it public: Package Settings → Change visibility → Public *(easiest)*
   - Or leave it private and authenticate on the server (see Step 3).

---

## Step 2 — Edit docker-compose.yml

Open `docker-compose.yml` and replace `YOUR_GITHUB_USERNAME` with your actual GitHub username (lowercase). The image name must match exactly what GHCR shows, e.g.:

```
ghcr.io/tgibs97/letterboxdtogether:latest
```

---

## Step 3 — Set up the server on TrueNAS

SSH into your TrueNAS box, then:

```bash
# Clone the repo somewhere on a dataset (not the boot pool)
git clone https://github.com/YOUR_USERNAME/LetterboxdTogether.git /mnt/tank/apps/letterboxd-together
cd /mnt/tank/apps/letterboxd-together

# Copy the example env file and fill in your values
cp .env.example .env
nano .env
```

If your GHCR package is **private**, log in once so Docker (and Watchtower) can pull it:

```bash
# Use a GitHub Personal Access Token with read:packages scope
docker login ghcr.io -u YOUR_GITHUB_USERNAME -p YOUR_PAT
```

Start everything:

```bash
docker compose up -d
```

Check it's running:

```bash
docker compose ps
docker compose logs -f app
```

The app is now running on the TrueNAS box. It's not publicly accessible yet — that's what the tunnel does.

---

## Step 4 — Cloudflare Tunnel

You need a domain pointed at Cloudflare nameservers. The tunnel works on any plan including free.

1. Go to [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → **Networks** → **Tunnels** → **Create a tunnel**.
2. Name it (e.g. `letterboxd-together`), click Save.
3. Choose **Docker** as the connector type — Cloudflare will show you a `docker run` command with a long token in it. **Copy just the token** (the long string after `--token`).
4. Add the token to your `.env` on TrueNAS:
   ```
   CLOUDFLARE_TUNNEL_TOKEN=eyJ...your token here...
   ```
5. Back in the tunnel wizard, click **Next** and configure the public hostname:
   - **Subdomain**: `films` (or whatever you want)
   - **Domain**: your domain
   - **Service**: `http://letterboxd-together:3000`
     *(This is the Docker service name from docker-compose.yml — containers on the same Compose network resolve each other by service name)*
6. Save the tunnel.

Restart Compose so cloudflared picks up the token:

```bash
docker compose up -d
```

Your app should now be live at `https://films.yourdomain.com`.

---

## Step 5 — Cloudflare Access (login screen)

1. In the Zero Trust dashboard → **Access** → **Applications** → **Add an application**.
2. Choose **Self-hosted**.
3. Fill in:
   - **Application name**: Letterboxd Together
   - **Subdomain / domain**: same as your tunnel hostname (`films.yourdomain.com`)
4. Click **Next**, then create a **Policy**:
   - **Policy name**: e.g. `Allowed users`
   - **Action**: Allow
   - **Include rule**: Emails → add each person's email address
     *(Or use "GitHub" / "Google" as an identity provider if you prefer OAuth login)*
5. Save. Anyone hitting your URL will now see a Cloudflare login page before they can reach the app.

---

## Auto-updates

After this setup, the update flow is fully automatic:

1. Push a change to `main`
2. GitHub Actions builds and pushes a new image to GHCR (~2 min)
3. Watchtower detects the new image within 5 minutes, pulls it, and restarts the app container
4. Zero downtime, no SSH needed

To trigger a manual check immediately:

```bash
docker exec letterboxd-watchtower /watchtower --run-once letterboxd-together
```

---

## Updating the server after a git change to compose/env

Watchtower only handles app image updates. If you change `docker-compose.yml` or `.env`, SSH in and run:

```bash
git pull
docker compose up -d
```
