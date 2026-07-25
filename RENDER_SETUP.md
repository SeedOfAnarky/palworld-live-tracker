# Render Free Deployment

This package is prepared for a Render **Free Web Service**.

## Before uploading

1. Change/rotate the Palworld REST Admin Password in DatHost.
2. Never put that password in this repository.
3. Create a private GitHub repository.
4. Upload the contents of this folder to the repository root.

The root should contain:

- `Dockerfile`
- `render.yaml`
- `package.json`
- `server.mjs`
- `public/`

## Simplest deployment: Render Blueprint

1. Sign in to the Render Dashboard using GitHub.
2. Click **New** → **Blueprint**.
3. Connect the private GitHub repository.
4. Render reads `render.yaml`.
5. Enter values when prompted for:
   - `TRACKER_PASSWORD`
   - `PALWORLD_HOST`
   - `PALWORLD_PASSWORD`
6. Apply/deploy the Blueprint.

Recommended values:

- `TRACKER_PASSWORD`: a new password used by players to open the website.
- `PALWORLD_HOST`: the DatHost hostname only, without `http://` and without a port.
- `PALWORLD_PASSWORD`: the newly rotated Palworld REST Admin Password.

Render supplies `PORT` automatically. Do not add it manually.

## Manual deployment alternative

1. Click **New** → **Web Service**.
2. Connect the private repository.
3. Choose:
   - Runtime/Language: **Docker**
   - Branch: `main`
   - Instance type: **Free**
   - Health check path: `/healthz`
4. Add all environment variables listed in `render.yaml`.
5. Deploy.

## Expected startup

The logs should include:

```text
Palworld Live Tracker
Mode: LIVE
Open: http://0.0.0.0:10000
Palworld REST: http://<your-host>:29148/v1/api
```

The public address will resemble:

```text
https://palworld-live-tracker.onrender.com
```

Opening it prompts for:

- Username: the `TRACKER_USERNAME` value
- Password: the `TRACKER_PASSWORD` value

## Free-tier behavior

Render Free Web Services spin down after 15 minutes without inbound traffic.
An open tracker page maintains an SSE connection and receives updates, so it
normally remains active during a gaming session. After a complete idle period,
the first visitor might wait about a minute for the service to wake.

The free filesystem is temporary. Maps, icons, and spawn tables may need to
download again after a restart, redeploy, or spin-down.
