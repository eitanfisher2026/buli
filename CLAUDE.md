# Buli (בולי) — Claude Context

Live family shopping-list PWA — a real product with real daily users (Eitan as owner/admin, plus Miri Altman and Dany Altman), not a side project. Treat bugs and UX rough edges as real user impact, not cosmetic.

- **Live:** buli-8fdf9.web.app
- **Repo:** github.com/eitanfisher2026/buli
- **Firebase project:** buli-8fdf9
- **Functions region:** europe-west1 (must match the client's `functions("europe-west1")` call)
- Sibling projects (same owner, separate everything): [roy-news](../roy-news/CLAUDE.md), [foufou-pets](../FouFou-Pets/CLAUDE.md) — nothing shared with those.

## Stack
- No build framework for the client — React + Firebase compat SDKs + Tailwind loaded via CDN `<script>` tags in `public/index.html`, JSX pre-compiled (see Build below).
- Firebase Realtime Database + Auth + Cloud Functions (2nd gen, Node 20).
- PWA with a service worker (`public/sw.js`) — same-origin network-first caching with a real fallback cache; does not touch cross-origin CDN requests.

## Build — MANDATORY every time `public/app.js` changes
`public/app.compiled.js` is generated from `public/app.js` and is **not committed to git** (gitignored). It's what `index.html` actually loads.

```bash
cd tools && node build.js   # must run from tools/, not repo root
```

Every change to `app.js` requires **all three** of these together, every time, or phones serve stale cached JS:
1. Rebuild (`node build.js` from `tools/`)
2. Bump the `VERSION` constant near the top of `app.js`
3. Bump the matching `?v=` cache-buster on the `app.compiled.js` script tag in `index.html`

## Deploy
```bash
firebase deploy --only hosting --project buli-8fdf9              # client changes
firebase deploy --only functions --project buli-8fdf9            # functions/index.js changes
```
Functions deploys routinely take 60-120s+ and may need to run in the background — that's normal, not a hang.

## Data model (Realtime DB)
- `lists/{listId}` — a list's metadata (`name`, `type`: `"shopping"` | `"notes"` | `"tasks"`, `ownerId`, `sharedWith: {uid: role}`, `isPrivate`, `done`, `createdAt`, `dinnerDate`/`dinersCount` for notes lists).
- `items/{listId}/{itemId}` — items in a list (`name`, `category`, `categoryEmoji`, `note`, `quantity`, `unit`, `done`, `addedBy`, `addedAt`, `barcodes: {vendorId: barcode}`).
- `listsByUser/{uid}` — index of lists a user owns or is shared into; keeps home-screen loads to a point-read instead of scanning the whole `lists` table.
- `users/{uid}/vendorProfiles/{profileId}` — a user's own tracked vendor+branch pairs for price comparison (`vendor`, `branchId`, `active`, `addedAt`).
- `vendorBranches/{vendor}`, `vendorCatalog/{vendor}/{branchId}`, `vendorCatalogIndex/{vendor}/{branchId}` — server-only (no client read/write rules), ingested from each vendor's price-transparency feed.
- Owner account: `eitanfisher100@gmail.com` (`OWNER_EMAIL` in `functions/index.js`) — always resolves to `role: 'admin'` regardless of the `authorizedUsers` table. "The default vendor list" (see below) is defined as *this account's* current `vendorProfiles`, not a separately maintained template.

## Sharing — two unrelated features, don't conflate them
- **Share a list** (per-list "שתף" button): grants another *existing Buli account* in-app access to that list. No email is ever sent — it's a direct DB permission write (`lists/{id}/sharedWith/{uid}`). Self-share is blocked with a distinct message.
- **Share the app** (Settings → "שתף את בולי"): a referral link via the native share sheet / clipboard. Nothing to do with list access.

## Vendor price-comparison feeds — critical, non-obvious quirks
Israeli supermarket chains publish price-transparency data under a legal mandate, but **not through one uniform mechanism** — verify each new vendor live before trusting any assumption:
- Most current vendors (`ramiLevy`, `osherAd`, `keshet`, `yohananof`, `superYuda`) share one FTP platform (`url.retail.publishedprices.co.il`, "Cerberus"), blank password by default — **except `superYuda`, which needs a real password AND has its files under an `/Yuda` subdirectory**, not the FTP root every other vendor here uses.
- `shufersal` does **not** use that FTP platform at all — it's HTTP-only, a paginated HTML file listing at `prices.shufersal.co.il` linking to signed Azure Blob URLs. Its **Stores** file (branch list) uses `<Chain>` as its XML root element, unlike literally every other file in this system (`<Root>`) — a silent, easy-to-miss schema mismatch that produced zero branches for a while.
- Before adding a new vendor: check the `OpenIsraeliSupermarkets/israeli-supermarket-scarpers` GitHub project for its real FTP/HTTP details, then confirm with a **live test** against the real server. Never guess a username/fake support — see `functions/index.js` VENDORS comments for the verified details and dates of each vendor already added.
- A vendor's branch-listing failing is not necessarily "no data available" — it has twice now turned out to be a specific, fixable integration bug (wrong root element, wrong subdirectory). Investigate before concluding a chain isn't accessible.

## Standing workflow rules (established over many sessions)
- **Decide and act, don't ask process questions.** Eitan is not technical and thinks in outcomes, not implementation mechanics. Once a change is scoped, carry it through edit → build → deploy → verify → commit → push without pausing for permission at each step. Reserve real stops for genuinely irreversible actions (force-push, deleting production data).
- **Batch fixes into one deploy, don't deploy after every tiny change.** Functions deploys are slow (60-120s+); serial one-fix-per-deploy cycles make a session feel very slow for no benefit. Fix everything reported, verify locally, then do one build/deploy/commit/push pass.
- **Before building something new, check whether it already exists.** Say what already exists first rather than silently building an adjacent version.
- Communicate in product-level terms (what changed, why it matters), not code details — see the global `~/.claude/CLAUDE.md` for the full communication-style rule shared across all of Eitan's projects.
