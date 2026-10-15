// Mirrors the SCTMG Cards community feedback board (Firestore `sctmg_feedback`
// in the `sctmg-cards` project) to GitHub issues in this repository.
//
// Runs from .github/workflows/sync.yml (every 15 min + manual dispatch).
// Env:
//   FIREBASE_SERVICE_ACCOUNT   JSON key (secret FIREBASE_SERVICE_ACCOUNT_SCTMG_CARDS)
//   GITHUB_TOKEN               default Actions token (issues: write)
//   GITHUB_REPOSITORY          owner/repo (set by Actions)
//   BOARD_URL                  default https://sctmg-cards.web.app/feedback.html
//   AUTO_PUBLISH_AFTER_HOURS   optional; empty = disabled
//   DRY_RUN=1                  log what would happen, write nothing
//
// Never syncs contact details (private/contact) or unapproved items.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

const REPO = process.env.GITHUB_REPOSITORY || 'ParisMeuleman/ctmg-cards-feedback';
const TOKEN = process.env.GITHUB_TOKEN || '';
const BOARD = process.env.BOARD_URL || 'https://sctmg-cards.web.app/feedback.html';
const AUTO_HOURS = Number.parseFloat(process.env.AUTO_PUBLISH_AFTER_HOURS || '');
const DRY = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const COL = 'sctmg_feedback';

export const STATUSES = ['open', 'planned', 'in_progress', 'done', 'declined'];
const REMOVED = new Set(['pending', 'hidden']);
const TYPE_LABEL = { bug: 'Bug', feature: 'Feature', question: 'Question' };
export const LABELS = [
  { name: 'type:bug', color: 'd73a4a', description: 'Bug report from the SCTMG feedback board' },
  { name: 'type:feature', color: 'a2eeef', description: 'Feature request from the SCTMG feedback board' },
  { name: 'type:question', color: 'd876e3', description: 'Question from the SCTMG feedback board' },
  { name: 'status:open', color: 'c5def5', description: 'Approved, not scheduled yet' },
  { name: 'status:planned', color: '5319e7', description: 'Planned' },
  { name: 'status:in_progress', color: '1d76db', description: 'Being worked on' },
  { name: 'status:done', color: '0e8a16', description: 'Done (close the issue with this label)' },
  { name: 'status:declined', color: 'cfd3d7', description: 'Declined (close the issue with this label)' },
];
const MARKER_RE = /Source: sctmg-feedback\/([A-Za-z0-9_-]+)/;
const ISSUE_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)$/;

const log = (...a) => console.log(...a);
const plan = (what) => { log(`${DRY ? '[dry-run] would ' : ''}${what}`); return !DRY; };

// --- GitHub REST -------------------------------------------------------------------

async function gh(method, path, body) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sctmg-feedback-sync',
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`https://api.github.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = res.status === 204 ? '' : await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${txt.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return txt ? JSON.parse(txt) : null;
}

async function ghAll(path) {
  const out = [];
  for (let page = 1; page < 100; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = await gh('GET', `${path}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

async function ensureLabels() {
  const existing = new Set((await ghAll(`/repos/${REPO}/labels`)).map(l => l.name));
  for (const l of LABELS) {
    if (existing.has(l.name)) continue;
    if (plan(`create label ${l.name}`)) await gh('POST', `/repos/${REPO}/labels`, l);
  }
}

// --- Pure helpers (exported for tests) ---------------------------------------------

/** Status expressed by an issue, or null if it does not express one. */
export function statusFromIssue(issue) {
  const names = new Set((issue.labels || []).map(l => (typeof l === 'string' ? l : l.name)));
  if (issue.state === 'closed') {
    if (names.has('status:declined')) return 'declined';
    if (names.has('status:done')) return 'done';
    return null; // closed without a verdict label (e.g. "removed by moderator")
  }
  for (const s of ['in_progress', 'planned', 'open']) if (names.has(`status:${s}`)) return s;
  return 'open';
}

/**
 * Decide the reconciled status. `last` is the last value both sides agreed on
 * (`githubSyncedStatus`). Firestore (moderator) wins when both changed.
 * Returns { status, pushToGitHub, pullToFirestore }.
 */
export function reconcile(fsStatus, ghStatus, last) {
  const fsChanged = fsStatus !== last;
  const ghChanged = ghStatus !== null && ghStatus !== last && STATUSES.includes(ghStatus);
  if (fsChanged || !ghChanged) return { status: fsStatus, pushToGitHub: fsChanged || (ghStatus !== null && ghStatus !== fsStatus), pullToFirestore: false };
  return { status: ghStatus, pushToGitHub: false, pullToFirestore: true };
}

const noMentions = s => String(s || '').replace(/@/g, '@\u200b');
const cell = s => noMentions(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function issueTitle(f) {
  return `[${f.type || 'bug'}] ${String(f.title || '').trim()}`.slice(0, 250);
}

export function issueBody(id, f, board = BOARD) {
  const c = f.context || {};
  const created = f.createdAt && typeof f.createdAt.toDate === 'function' ? f.createdAt.toDate().toISOString().slice(0, 10) : '';
  const source = { public: 'Public site', 'public-embed': 'sc.starcraft-tmg.com print tool', prerelease: 'Pre-release' }[f.source];
  const rows = [
    ['Type', TYPE_LABEL[f.type] || f.type],
    ['Submitted', created],
    ['Source', source], // beta-sourced items never show their origin publicly
    ['Page', c.page],
    ['Channel', c.channel],
    ['App version', c.appVersion],
    ['Language', c.lang],
    ['Unit format', c.unitFormat],
  ].filter(([, v]) => v);
  return [
    noMentions(f.body || ''),
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
    '',
    `[View and vote on the SCTMG feedback board](${board}#fb-${id})`,
    '',
    `<sub>Mirrored automatically from the moderated feedback board — please vote and comment there. Source: sctmg-feedback/${id}</sub>`,
  ].join('\n');
}

function labelsFor(issue, type, status) {
  const keep = (issue ? issue.labels || [] : []).map(l => (typeof l === 'string' ? l : l.name))
    .filter(n => !n.startsWith('status:') && !n.startsWith('type:'));
  return [...keep, `type:${type || 'bug'}`, `status:${status}`];
}

// --- Issue operations --------------------------------------------------------------

async function applyStatus(issue, f, status) {
  const closed = status === 'done' || status === 'declined';
  const patch = { labels: labelsFor(issue, f.type, status), state: closed ? 'closed' : 'open' };
  if (closed) patch.state_reason = status === 'declined' ? 'not_planned' : 'completed';
  if (plan(`set #${issue.number} → ${status} (${patch.state})`)) await gh('PATCH', `/repos/${REPO}/issues/${issue.number}`, patch);
}

async function removeIssue(issue, why) {
  if (issue.state === 'closed' && issue.locked) return;
  if (!plan(`close + lock #${issue.number} (${why})`)) return;
  if (issue.state !== 'closed') {
    await gh('POST', `/repos/${REPO}/issues/${issue.number}/comments`, { body: 'Removed by moderator.' });
    await gh('PATCH', `/repos/${REPO}/issues/${issue.number}`, { state: 'closed', state_reason: 'not_planned' });
  }
  if (!issue.locked) await gh('PUT', `/repos/${REPO}/issues/${issue.number}/lock`, { lock_reason: 'resolved' });
}

// --- Main ----------------------------------------------------------------------------

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw) {
    console.log('::warning::FIREBASE_SERVICE_ACCOUNT is not set (secret FIREBASE_SERVICE_ACCOUNT_SCTMG_CARDS) — nothing to do.');
    return;
  }
  if (!TOKEN && !DRY) throw new Error('GITHUB_TOKEN is required (or DRY_RUN=1).');
  const sa = JSON.parse(raw);
  initializeApp({ credential: cert(sa), projectId: sa.project_id });
  const db = getFirestore();
  const col = db.collection(COL);

  // Optional soft auto-publish (never beta-sourced, never flagged).
  if (Number.isFinite(AUTO_HOURS) && AUTO_HOURS > 0) {
    const cutoff = Timestamp.fromMillis(Date.now() - AUTO_HOURS * 3600 * 1000);
    const pending = await col.where('status', '==', 'pending').get();
    for (const d of pending.docs) {
      const f = d.data();
      const eligible = f.flagged === false && ['public', 'public-embed'].includes(f.source)
        && f.createdAt && f.createdAt.toMillis() <= cutoff.toMillis();
      if (eligible && plan(`auto-publish ${d.id} "${f.title}"`)) {
        await d.ref.update({ status: 'open', visible: true, updatedAt: FieldValue.serverTimestamp() });
      }
    }
  }

  if (TOKEN && !DRY) await ensureLabels();
  else if (TOKEN) log('[dry-run] would ensure labels', LABELS.map(l => l.name).join(', '));

  const docs = (await col.get()).docs;
  const byId = new Map(docs.map(d => [d.id, d]));
  const issues = (await ghAll(`/repos/${REPO}/issues?state=all`)).filter(i => !i.pull_request);
  const issueByDoc = new Map();
  for (const i of issues) {
    const m = MARKER_RE.exec(i.body || '');
    if (m && !issueByDoc.has(m[1])) issueByDoc.set(m[1], i);
  }
  const issueByNumber = new Map(issues.map(i => [i.number, i]));
  let created = 0, updated = 0, pulled = 0, removed = 0;

  for (const d of docs) {
    const f = d.data();
    const linked = (() => {
      const m = ISSUE_URL_RE.exec(f.githubIssue || '');
      return (m && issueByNumber.get(Number(m[1]))) || issueByDoc.get(d.id) || null;
    })();

    if (f.visible !== true || REMOVED.has(f.status)) {
      if (linked) { await removeIssue(linked, `document ${f.status}`); removed++; }
      continue;
    }

    if (!linked) {
      if (plan(`create issue for ${d.id} "${issueTitle(f)}"`)) {
        const issue = await gh('POST', `/repos/${REPO}/issues`, {
          title: issueTitle(f), body: issueBody(d.id, f), labels: labelsFor(null, f.type, f.status),
        });
        if (f.status === 'done' || f.status === 'declined') await applyStatus(issue, f, f.status);
        await d.ref.update({ githubIssue: issue.html_url, githubSyncedStatus: f.status });
      }
      created++;
      continue;
    }

    // Re-published after a moderator removal: unlock so the status can be mirrored again.
    if (linked.locked && plan(`unlock #${linked.number} (document visible again)`)) {
      await gh('DELETE', `/repos/${REPO}/issues/${linked.number}/lock`);
    }
    const last = f.githubSyncedStatus || f.status;
    const r = reconcile(f.status, linked.locked ? null : statusFromIssue(linked), linked.locked ? null : last);
    if (r.pullToFirestore) {
      if (plan(`Firestore ${d.id}: ${f.status} → ${r.status} (from #${linked.number})`)) {
        await d.ref.update({ status: r.status, visible: true, githubSyncedStatus: r.status, updatedAt: FieldValue.serverTimestamp() });
      }
      pulled++;
    } else {
      if (r.pushToGitHub || linked.locked) { await applyStatus(linked, f, r.status); updated++; }
      const patch = {};
      if (f.githubSyncedStatus !== r.status) patch.githubSyncedStatus = r.status;
      if (f.githubIssue !== linked.html_url) patch.githubIssue = linked.html_url;
      if (Object.keys(patch).length && plan(`Firestore ${d.id}: ${JSON.stringify(patch)}`)) await d.ref.update(patch);
    }
  }

  // Issues whose document was deleted.
  for (const [id, issue] of issueByDoc) {
    if (!byId.has(id)) { await removeIssue(issue, 'document deleted'); removed++; }
  }

  log(`done: ${docs.length} docs, ${issues.length} issues — created ${created}, updated ${updated}, pulled ${pulled}, removed ${removed}${DRY ? ' (dry run)' : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
