# SCTMG Cards — feedback tracker (GitHub mirror)

Public mirror of the moderated community feedback board of
[SCTMG Cards](https://sctmg-cards.web.app):
**https://sctmg-cards.web.app/feedback.html** — please report bugs, suggest
features and **vote there**. Reports are reviewed by a maintainer before they
become public; approved ones appear here automatically as issues.

> [!WARNING]
> This repository is **public**. Never post beta-only (NDA) content: rules
> text, stats, names of unreleased units/cards, or screenshots of beta
> material. Such reports are removed.

## What syncs (`sync.mjs`, every 15 minutes)

The scheduled workflow [`.github/workflows/sync.yml`](.github/workflows/sync.yml)
runs `sync.mjs`, which reads the Firestore collection `sctmg_feedback` of the
`sctmg-cards` Firebase project with the Firebase Admin SDK:

| Board (Firestore) | GitHub |
|---|---|
| Item approved (`visible == true`, no `githubIssue`) | New issue `[type] title` with the description, a context table, a link back to the board and a `Source: sctmg-feedback/<docId>` marker; labels `type:*` + `status:*`. The issue URL is written back to the item (`githubIssue`). |
| Status changed by a moderator | `status:*` label replaced; `done` / `declined` close the issue, other statuses reopen it. |
| — | On GitHub, adding `status:planned` / `status:in_progress`, or closing with `status:done` / `status:declined`, updates the board. If both sides changed since the last sync, the board (moderator) wins. |
| Item hidden, moved back to pending, or deleted | Issue closed with “Removed by moderator.” and locked. |
| *(optional)* `AUTO_PUBLISH_AFTER_HOURS` | Pending, **unflagged** items submitted from the public site (`public`, `public-embed`) older than N hours are published automatically. Items from the NDA beta tool or flagged as possibly containing NDA material are **never** auto-published. Disabled when empty. |

Never synced: contact details (e-mail, account, user agent — stored in an
admin-only sub-document), pending or hidden items, and the origin of items
submitted from the beta tool. Issues opened directly on GitHub are **not**
imported into the board.

Labels (created by the script if missing): `type:bug`, `type:feature`,
`type:question`, `status:open`, `status:planned`, `status:in_progress`,
`status:done`, `status:declined`.

## Setup

1. **Secret** `FIREBASE_SERVICE_ACCOUNT_SCTMG_CARDS` (Settings → Secrets and
   variables → Actions → New repository secret): the JSON key of
   `feedback-sync@sctmg-cards.iam.gserviceaccount.com` (role *Cloud Datastore
   User* on `sctmg-cards` only). Without it the workflow logs a warning and
   does nothing.
2. *(optional)* **Variable** `AUTO_PUBLISH_AFTER_HOURS` (Actions → Variables),
   e.g. `48`. Leave unset to disable auto-publishing.
3. The default `GITHUB_TOKEN` is used for issues (`permissions: issues: write`).
4. Run once manually: Actions → *Sync feedback board* → *Run workflow*
   (tick *Dry run* to only log what would happen).

## Local run

```sh
npm ci
npm test                                   # unit tests of the pure helpers
FIREBASE_SERVICE_ACCOUNT="$(cat key.json)" DRY_RUN=1 node sync.mjs
```
