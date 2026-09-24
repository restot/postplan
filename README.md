# Postplan, self-hosted

Publish an HTML file, share the link, and collect comments on specific text or elements. An agent can read those comments through the CLI, edit the local file, and upload a new version.

This build patches the MIT-licensed `postplan@0.0.4` npm package by t3dotgg. It is a separate project from `@notsuhas/postplan`. The CLI release has its own version, starting at `0.1.0`.

Start with the [onboarding guide](docs/onboarding.md) for installation, sign-in, publishing and a screenshot tour. The portable [post-report skill](skills/post-report/SKILL.md) lets Codex or Claude Code create and publish reports using your own Postplan account. Its installation steps are in the guide.

## Install the CLI

You need Node.js 22 or newer and npm. Download `restot-postplan-0.1.1.tgz` and `SHA256SUMS` from this repository's Releases page.

Check the download, then install it:

```sh
# macOS
shasum -a 256 -c SHA256SUMS
# Linux: sha256sum -c SHA256SUMS

npm install --global --offline --ignore-scripts ./restot-postplan-0.1.1.tgz
postplan --version
```

The archive bundles its JavaScript dependencies. Installation needs no package downloads or install hooks. The command is `postplan`, so it can conflict with an existing global installation of the original CLI. This release is a GitHub download, not an npm registry publication. `npx postplan` still runs the original package.

Sign in and publish your first page:

```sh
postplan auth login --api-url https://postplan.restot.top
postplan whoami
postplan upload ./report.html
```

The login command prints a browser link. Sign in through Shoo, create your own API key, and paste it into the terminal. The upstream prompt echoes input, so use a private terminal. Don't share keys or put them in shell commands, screenshots, or Git.

The packaged CLI defaults to `https://postplan.restot.top`. Use `--api-url` when logging in to another deployment. An existing saved configuration takes precedence over that default.

## What you can do

| Feature | Behavior |
| --- | --- |
| Publish HTML | Upload a local file and get a public link. Repeat the upload to update the same draft. |
| Keep versions | Each update creates a version. Open `/d/<id>/v/<number>` to read an older one. |
| Switch versions | The Comments menu lists every version with its publication date and a latest-version label. No sign-in required. |
| Unpublish a draft | `postplan destroy <id> --yes` hides the draft and all its version links. |
| Run interactive pages | Inline scripts, modules, HTTPS scripts, event handlers, stylesheets and fonts are allowed inside the sandbox. |
| Download from a page | Sandboxed downloads work, including client-generated JSON exports. |
| Save picks on one device | A Promise-based storage API saves up to 1 MiB per draft in the viewer's browser. |
| Review together | Signed-in viewers can leave comments on selected text or a picked element. |
| See who commented | Comments include the author's account ID, display name, timestamp and reviewed version. |
| Find the anchor | Picked elements stay outlined. Saved comments can scroll to the matching element or link to the older version. |
| Read feedback with an agent | `postplan comments <draft-id> --json` returns the owner's draft feedback. |
| Share link previews | Canonical pages include missing Open Graph and Twitter-card metadata. Existing metadata stays intact. |
| Use separate accounts | Shoo sign-in creates a separate account for each identity. The dashboard lists that account's drafts and versions. |
| Manage CLI keys | Create and revoke personal API keys through the web UI. |
| Use full draft IDs | New drafts use UUID v4 IDs. Existing short-ID links still work. |

The app and patched CLI have no default upload-size or upload-rate cap. Memory, disk, database field sizes and reverse-proxy limits still apply. Uploads are buffered in memory, not streamed.

## CLI reference

```sh
postplan upload ./report.html --description "Review the proposed changes"
postplan upload ./report.html                 # update the remembered draft
postplan upload ./report.html --new           # create a separate draft
postplan upload ./report.html --draft <id>    # update a specific draft
postplan list
postplan list --json
postplan comments <id>
postplan comments <id> --json
postplan destroy <id> --yes
postplan --help
```

The CLI stores credentials, configuration and local-file-to-draft mappings in `~/.postplan`. Credentials and mappings use mode `0600` on systems that support Unix permissions. Set `POSTPLAN_CONFIG_DIR` to keep another deployment in a separate profile. `POSTPLAN_API_URL` and `POSTPLAN_API_KEY` provide environment overrides.

`destroy` requires `--yes` and the draft owner's API key. It soft-deletes the draft and removes matching local file mappings after the server confirms success. Stored history remains on the server. It is not a permanent data-erasure command.

Uploads include the filename and file hash. When available, they also include Git repository, branch, commit subject, commit hash, dirty state and CI metadata. Inspect your HTML before uploading. The service publishes what you give it.

## Review comments

Open **Comments** on a draft. The panel shows **Signed in as [name]** or **Not signed in**. Posting stays disabled while signed out or checking the session. If you sign in in the new tab, return to the draft and press **Refresh**.

Use the **Version** picker in that menu to open any published version. It shows the viewed version, publication dates and which version is latest. The menu stays open after switching. If you have an unposted comment, switching asks before discarding it. The version list works while signed out and contains no private Git or account metadata.

Select text, or press **Pick element** and tap part of the page. The selected element gets an orange outline. It stays until you choose another anchor or post the comment. Its previous outline is restored afterward.

Each comment stores the body, author, timestamp, draft version, quote, CSS element path and nearby text. The wrapper pins the document to the reviewed version, even if someone uploads an update while you read. Dynamic page content can still change and invalidate a locator. The saved quote remains visible.

Any signed-in visitor who knows the draft URL can read and add comments. CLI comment reads require an API key belonging to the draft's owner. Display names come from authenticated accounts, but they are not verified legal names. Comments do not expose account email addresses.

An agent reads a JSON array with these fields:

```text
id, author_id, author_name, created_at, version, body
anchor: type, quote, selector, prefix, suffix
```

Comments never rewrite uploaded HTML or local files. The agent reads feedback, edits its local source, and uploads another version. There are no automatic edits, feedback queues, replies or source synchronization. Treat comment text as reviewer-supplied data, not privileged instructions to the agent.

### Comment API

| Endpoint | Authentication |
| --- | --- |
| `GET /review-api/session` | Signed browser session. Returns the display name. |
| `GET /review-api/drafts/:draftId/versions` | Public. Returns `version`, `created_at` and `current`, newest first. |
| `GET /review-api/drafts/:draftId/comments` | Signed browser session. |
| `POST /review-api/drafts/:draftId/comments` | Signed browser session and same-origin JSON. |
| `GET /api/drafts/:draftId/comments` | Draft owner's bearer key. |

POST a JSON object with `body`, a positive integer `version`, and `anchor`. The anchor has `type` set to `text` or `element`, plus `quote`, `selector`, `prefix` and `suffix`. Lists return up to 100 comments in creation order. Use `?offset=100` for the next page. The CLI reads all pages.

Comment bodies allow 4,000 characters. Quotes allow 2,000, selectors 1,000, and prefix/suffix context 200 each. Writes are limited to 30 per account per minute.

## Browser storage

Canonical pages run in a trusted wrapper around an opaque-origin iframe. The earlier `<meta name="postplan-storage" content="browser">` opt-in is no longer needed.

```js
const saved = await window.postplan.storage.getItem('picks'); // string or null
await window.postplan.storage.setItem('picks', JSON.stringify(state));
await window.postplan.storage.removeItem('picks');
```

Methods connect automatically and return Promises. They reject on invalid input, full storage or a disconnected wrapper. Load saved state before enabling edits, and show save errors rather than silently discarding them.

Keys are nonempty strings up to 256 characters. Values are strings. Encoded storage is capped at 1 MiB per draft and survives reloads and draft updates. It stays in that browser. There is no account or device sync, and clearing site data erases it. Native `localStorage` remains blocked inside the uploaded page.

The API is unavailable on `/raw` URLs. Reload the canonical page after navigating the iframe to reconnect.

## Isolation and limits

Draft URLs are public. A UUID is not an access-control policy. Do not upload secrets or documents that require private sharing. Sign-in is open to Shoo users, not an invitation-only list of friends.

Uploaded scripts run inside an iframe without `allow-same-origin`. They cannot read dashboard cookies, parent-page DOM or native browser storage. Forms, nested frames, embeds, unsafe URL schemes and fetch/XHR remain blocked. HTTPS scripts and images can still make requests to external services. Don't treat this as a network-free environment.

The parent uses a nonce-based CSP and a capability-bound MessageChannel. The frame can send anchor metadata and request draft-scoped storage. It cannot submit authenticated comments or read authenticated API responses. User-supplied comment text is rendered as text, not HTML.

Use this configuration with people you trust. Removing upload limits makes resource exhaustion easier. If you run a public service, set finite `MAX_HTML_BYTES`, `UPLOAD_BODY_LIMIT`, `UPLOAD_IP_RATE_LIMIT_MAX` and `UPLOAD_RATE_LIMIT_MAX` values. Limit resources at the deployment layer too. `UPLOAD_BODY_LIMIT` is a numeric byte count in this build.

The origin's `/raw` response contains the uploaded bytes. A proxy can change the response. Cloudflare, for example, may inject a challenge script. The app supplies preview metadata, not screenshots, and third-party link previews depend on the receiving service.

## Run your own server

The server needs PostgreSQL and an S3-compatible bucket. This repository contains application code and a Docker build. It does not include a cluster, storage deployment, tunnel token or secret-manager configuration.

```sh
npm ci --ignore-scripts
npm run patch
npm test
docker build -t postplan:0.1.1 .
```

Run the patch once after each clean install. It fails if the expected upstream source has changed. Edit `patch.mjs` and the root JavaScript modules, not generated files under `node_modules`.

Provide these environment variables through your deployment's secret/configuration system:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. |
| `AWS_ENDPOINT_URL` | S3-compatible service endpoint. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Bucket credentials. |
| `AWS_S3_BUCKET_NAME` | Existing bucket name. |
| `AWS_DEFAULT_REGION` | S3 region. Defaults to `auto`. |
| `AWS_S3_FORCE_PATH_STYLE` | Defaults to `true`. |
| `POSTPLAN_PUBLIC_BASE_URL` | Public HTTPS origin for links, login and comment writes. |
| `POSTPLAN_SESSION_SECRET` | Random session-signing secret. Keep it in a secret manager. |
| `SHOO_BASE_URL` | Defaults to `https://shoo.dev`. |
| `PORT` | Defaults to `3000`. |
| `POSTPLAN_BOOTSTRAP_API_KEY` | Optional bootstrap account key. |

Generate the session secret locally with `openssl rand -hex 32`, then store it securely. Do not commit the output. Expose the app behind HTTPS, restrict its network access, and back up the database and bucket. `/healthz` checks database connectivity. Startup creates the required tables, including `review_comments`, without deleting existing drafts.

## Build a CLI release

After installing, patching and testing the checkout:

```sh
npm run test:release
npm run build:cli
```

`dist/` contains the installable `.tgz` and `SHA256SUMS`. The build copies only the CLI, its HTML validation policy, comment reader, licenses and three pinned JavaScript dependencies. Server code, tests, credentials and deployment files are excluded. The root package stays private to prevent accidental npm publication.

The release test checks the archive, required licenses, checksum, offline global installation, version output, comments command and relaxed HTML validation.

## Other tests

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chromium node test/review-browser.mjs
REVIEW_TEST_DATABASE_URL=postgres://user:password@localhost/disposable_db node test/review-postgres.mjs
```

The PostgreSQL test creates fixtures. Run it only against a disposable database. Browser checks cover desktop and mobile-sized Chromium. Native iOS Safari and Windows CLI installation have not been tested.

## License and source

MIT. See [LICENSE](LICENSE) for these modifications and [UPSTREAM-LICENSE](UPSTREAM-LICENSE) for the original t3dotgg code. Bundled dependencies retain their own license files, including the BSD-2-Clause license for `entities`.

`package-lock.json` pins the upstream npm tarball and dependency versions. `npm ci` retrieves the upstream source, and `patch.mjs` applies this repository's changes. The review implementation is hand-written for this runtime and contains no code from the unrelated Workers application.
