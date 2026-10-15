// Unit tests for the pure helpers of sync.mjs (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusFromIssue, reconcile, issueBody, issueTitle } from './sync.mjs';

const issue = (state, ...labels) => ({ state, labels: labels.map(name => ({ name })) });

test('statusFromIssue', () => {
  assert.equal(statusFromIssue(issue('open', 'type:bug')), 'open');
  assert.equal(statusFromIssue(issue('open', 'status:planned')), 'planned');
  assert.equal(statusFromIssue(issue('open', 'status:planned', 'status:in_progress')), 'in_progress');
  assert.equal(statusFromIssue(issue('closed', 'status:done')), 'done');
  assert.equal(statusFromIssue(issue('closed', 'status:declined')), 'declined');
  assert.equal(statusFromIssue(issue('closed', 'type:bug')), null);
});

test('reconcile: Firestore change is pushed', () => {
  assert.deepEqual(reconcile('planned', 'open', 'open'), { status: 'planned', pushToGitHub: true, pullToFirestore: false });
});

test('reconcile: GitHub change is pulled', () => {
  assert.deepEqual(reconcile('open', 'in_progress', 'open'), { status: 'in_progress', pushToGitHub: false, pullToFirestore: true });
  assert.deepEqual(reconcile('in_progress', 'done', 'in_progress'), { status: 'done', pushToGitHub: false, pullToFirestore: true });
});

test('reconcile: both changed → Firestore (moderator) wins', () => {
  assert.equal(reconcile('declined', 'done', 'open').status, 'declined');
});

test('reconcile: closed without verdict label is not pulled', () => {
  assert.deepEqual(reconcile('open', null, 'open'), { status: 'open', pushToGitHub: false, pullToFirestore: false });
});

test('issue body: no beta source, mentions defused, marker present', () => {
  const body = issueBody('abc123', {
    type: 'bug', title: 't', body: 'hi @someone', source: 'beta',
    context: { page: 'units', channel: 'production' },
  }, 'https://example.test/feedback.html');
  assert.ok(!/beta/i.test(body.replace('sctmg-feedback', '')), body);
  assert.ok(body.includes('@\u200bsomeone'));
  assert.ok(body.includes('Source: sctmg-feedback/abc123'));
  assert.ok(body.includes('https://example.test/feedback.html#fb-abc123'));
  assert.equal(issueTitle({ type: 'feature', title: '  More cards ' }), '[feature] More cards');
});
