# Postplan homelab build

Reproducible patches for the `postplan` npm package, pinned to version 0.0.4. This is the build used by the self-hosted Postplan deployment, not a fork of the unrelated `@notsuhas/postplan` Workers application.

## Build and test

Use Node.js 22 or newer.

```sh
npm ci --ignore-scripts
npm run patch
npm test
```

Run the patch once after each clean install. It deliberately fails when the upstream source does not match the expected version. Edit `patch.mjs` and `preview.js`, not generated files under `node_modules`.

```sh
docker build -t postplan:0.0.4-homelab .
```

## CLI

```sh
node node_modules/postplan/bin/postplan.js auth login --api-url https://postplan.restot.top
node node_modules/postplan/bin/postplan.js whoami
node node_modules/postplan/bin/postplan.js upload /path/to/report.html
```

Authentication prompts for a key and stores it in `~/.postplan/credentials.json`. Never commit this file. Use `POSTPLAN_CONFIG_DIR` for a separate profile. The stock `npx postplan` package does not include these patches.

## Behavior and remaining limits

- Removes application upload-size and upload-rate caps. Cloudflare request limits, available memory and disk capacity still apply; uploads are buffered.
- Allows inline and HTTPS external JavaScript, modules, event handlers, stylesheets and fonts. The browser sandbox excludes same-origin privileges; forms, frames, unsafe URL schemes, browser storage and fetch/XHR remain restricted.
- Adds missing Open Graph and Twitter-card metadata to canonical pages. Existing metadata is preserved; raw downloads retain original bytes. No preview screenshots are generated.
- Requires bearer authentication before parsing API upload bodies.

The upstream web UI supports Shoo authentication using `SHOO_BASE_URL`, `POSTPLAN_PUBLIC_BASE_URL` and `POSTPLAN_SESSION_SECRET`. Keep the session secret in a secret manager. Shoo identities receive separate accounts, without an owner-only allowlist.

Runtime PostgreSQL, S3 storage, secrets and Kubernetes configuration are managed separately in the private infrastructure repository. This repository contains no deployment credentials or report data.

## Provenance

`package-lock.json` pins the upstream dependency and its integrity hash. `UPSTREAM-LICENSE` preserves its MIT license notice. The Dockerfile applies the same patches and runs the tests during the image build.
