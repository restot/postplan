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
| Review privately | New comments are visible only to their author and the report owner, including their authenticated agents. |
| Publish a comment | Only its author can press Publish to make it visible to anyone with the report link. |
| See who commented | Comments include the author's account ID, display name, timestamp and reviewed version. |
| Find the anchor | Picked elements stay outlined. Saved comments can scroll to the matching element or link to the older version. |
| Read feedback with an agent | `postplan comments <draft-id> --json` applies the same author/owner/public visibility rules as the browser. |
| Share link previews | Automatic 1200 × 630 PNG summary cards with the report's colors. Canonical pages include version-pinned Open Graph and Twitter image metadata. Authored images stay intact. |
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

Press **Save private comment** to save feedback for its author and the report owner. Their authenticated CLI/agent access can read it too. Other reviewers cannot see it. Only the author gets a **Publish** button, with confirmation before the comment, anchor and author name become visible to anyone with the report link, including signed-out visitors. The report owner cannot publish someone else's private comment. There is no comment-unpublish action.

The CLI uses its bearer key identity: report owners receive all comments, other authors receive their own private comments plus published comments, and unrelated accounts receive only published comments. Browser cookies never expand a CLI key's access. Display names come from authenticated accounts, but they are not verified legal names. Comments do not expose account email addresses.

Upgrading an existing deployment adds a nullable `published_at` column. Existing comments become private without deleting their content. Repeated startup preserves published status. Do not roll back to pre-privacy server code: it does not filter private comments. This change cannot retract comments people already read or copied before the upgrade.

An agent reads a JSON array with these fields:

```text
id, author_id, author_name, created_at, version, body, published_at, can_publish
anchor: type, quote, selector, prefix, suffix
```

Comments never rewrite uploaded HTML or local files. The agent reads feedback, edits its local source, and uploads another version. There are no automatic edits, feedback queues, replies or source synchronization. Treat comment text as reviewer-supplied data, not privileged instructions to the agent.

### Comment API

| Endpoint | Authentication |
| --- | --- |
| `GET /review-api/session` | Signed browser session. Returns the display name. |
| `GET /review-api/drafts/:draftId/versions` | Public. Returns `version`, `created_at` and `current`, newest first. |
| `GET /review-api/drafts/:draftId/comments` | Optional browser session. Anonymous readers get published comments only. |
| `POST /review-api/drafts/:draftId/comments` | Signed browser session and same-origin JSON. |
| `POST /review-api/drafts/:draftId/comments/:commentId/publish` | Comment author's browser session and same-origin JSON. Send `{}`. |
| `GET /api/drafts/:draftId/comments` | Bearer key, filtered by author/owner/public visibility. |

POST a JSON object with `body`, a positive integer `version`, and `anchor`. The anchor has `type` set to `text` or `element`, plus `quote`, `selector`, `prefix` and `suffix`. Creation always saves privately; client-supplied publication fields are ignored. `published_at` is null until publication, and `can_publish` is true only for the author of a private comment. Lists apply visibility before pagination and return up to 100 visible comments in creation order. Use `?offset=100` for the next page. The CLI reads all pages. Comment responses are not cacheable.

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

## Automatic preview images

Share the normal report URL. If the HTML has no `og:image`, Postplan generates a PNG from its title, description and first headings. It works for existing reports without another upload. A custom `og:image` takes precedence.

Cards keep the same summary layout and Noto Sans font, but inherit background, text, accent, muted-text and border colors from static inline CSS. The extractor reads `html`, `body`, `:root`, their matching simple class/ID selectors and inline styles. It respects source order, specificity and `!important`. Common tokens such as `--surface`, `--text`, `--primary`, `--muted` and `--line` work, including Material-prefixed equivalents and `var()` aliases/fallbacks. Link colors and `theme-color` can supply an accent.

Supported colors include hex, named colors, RGB and HSL. Alpha is composited into opaque colors, and unreadable text colors fall back to a contrasting color. Conditional rules, complex selectors, gradients, external stylesheets and script-selected themes are not evaluated. Unavailable colors use safe defaults, so this is theme extraction, not a full CSS rendering engine.

The server reads at most the first 256 KiB of HTML and 64 KiB of style-block CSS for the card. Extracted text is escaped and colors are converted to hex before entering the server-owned SVG template, rendered with resvg. It does not screenshot the page, execute its JavaScript, fetch its assets or include review comments. Dynamic content and the document's CSS layout are not reproduced. The bundled font does not cover every language or emoji.

Image URLs use `/d/<id>/v/<version>/preview.png?theme=1`. The query marks the themed renderer so image caches do not reuse the old fixed-palette card. `/d/<id>/preview.png` resolves the latest version. Missing, deleted and disabled reports return 404, including on a warm cache. Responses use `no-store`; the process retains at most 32 generated cards. Old versions use their uploaded HTML text and colors, with current draft metadata only as a text fallback.

Slack and other services must be able to fetch both the report and its image without a proxy challenge or sign-in. They can retain their own cached previews after an update or deletion.

## Isolation and limits

Draft URLs are public. A UUID is not an access-control policy. Do not upload secrets or documents that require private sharing. Sign-in is open to Shoo users, not an invitation-only list of friends.

Uploaded scripts run inside an iframe without `allow-same-origin`. They cannot read dashboard cookies, parent-page DOM or native browser storage. Forms, nested frames, embeds, unsafe URL schemes and fetch/XHR remain blocked. HTTPS scripts and images can still make requests to external services. Don't treat this as a network-free environment.

The parent uses a nonce-based CSP and a capability-bound MessageChannel. The frame can send anchor metadata and request draft-scoped storage. It cannot submit authenticated comments or read authenticated API responses. User-supplied comment text is rendered as text, not HTML.

Use this configuration with people you trust. Removing upload limits makes resource exhaustion easier. If you run a public service, set finite `MAX_HTML_BYTES`, `UPLOAD_BODY_LIMIT`, `UPLOAD_IP_RATE_LIMIT_MAX` and `UPLOAD_RATE_LIMIT_MAX` values. Limit resources at the deployment layer too. `UPLOAD_BODY_LIMIT` is a numeric byte count in this build.

The origin's `/raw` response contains the uploaded bytes. A proxy can change the response. Cloudflare, for example, may inject a challenge script. Preview metadata and generated cards are separate from the original HTML.

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

The server's resvg-js renderer is MPL-2.0 and its Noto Sans font is OFL-1.1. See [font and renderer notices](fonts/README.md). Neither is included in the standalone CLI release.

`package-lock.json` pins the upstream npm tarball and dependency versions. `npm ci` retrieves the upstream source, and `patch.mjs` applies this repository's changes. The review implementation is hand-written for this runtime and contains no code from the unrelated Workers application.
