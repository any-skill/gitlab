import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE, PROJECT, httpMock, invoke } from './helpers.js';

const DISCUSSION = '0123456789abcdef0123456789abcdef01234567';
const mr = { id: 300, iid: 3, sha: 'abcd1234', state: 'opened' };
const versions = [{ id: 51, head_commit_sha: 'abcd1234' }];
const version = {
  id: 51,
  base_commit_sha: 'base',
  start_commit_sha: 'start',
  head_commit_sha: 'abcd1234',
  diffs: [
    {
      old_path: 'src/app.js',
      new_path: 'src/app.js',
      diff: '@@ -1,2 +1,3 @@\n line1\n+added\n line2\n',
    },
  ],
};
const position = {
  position_type: 'text',
  base_sha: 'base',
  start_sha: 'start',
  head_sha: 'abcd1234',
  old_path: 'src/app.js',
  new_path: 'src/app.js',
  new_line: 2,
};
const directory = await mkdtemp(join(tmpdir(), 'any-skill-gitlab-review-'));

after(() => rm(directory, { recursive: true, force: true }));

test('mr-discussion-create computes the diff position from the latest version', async () => {
  const mock = httpMock([
    { path: `${BASE}/merge_requests/3/versions`, data: versions },
    { path: `${BASE}/merge_requests/3/versions/51`, data: version },
    {
      method: 'POST',
      path: `${BASE}/merge_requests/3/discussions`,
      body: { body: 'Handle empty input', position },
      status: 201,
      data: { id: DISCUSSION, notes: [{ id: 1, resolvable: true, resolved: false }] },
    },
  ]);
  const result = await invoke(
    [
      'mr-discussion-create',
      ...PROJECT,
      '--iid',
      '3',
      '--path',
      'src/app.js',
      '--new-line',
      '2',
      '--body',
      'Handle empty input',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.output.data.resolvable, true);
  assert.equal(result.output.data.resolved, false);
  mock.done();
});

test('a general thread needs no diff lookup and diff options need --path', async () => {
  const general = httpMock([
    {
      method: 'POST',
      body: { body: 'Overall question' },
      status: 201,
      data: { id: DISCUSSION, notes: [] },
    },
  ]);
  const created = await invoke(
    ['mr-discussion-create', ...PROJECT, '--iid', '3', '--body', 'Overall question'],
    general,
  );
  const invalid = await invoke(
    ['mr-discussion-create', ...PROJECT, '--iid', '3', '--new-line', '2', '--body', 'x'],
    httpMock([]),
  );
  const noLine = await invoke(
    ['mr-discussion-create', ...PROJECT, '--iid', '3', '--path', 'src/app.js', '--body', 'x'],
    httpMock([]),
  );

  assert.equal(created.exitCode, 0, created.stderr);
  assert.equal(invalid.exitCode, 2);
  assert.equal(noLine.exitCode, 2);
  general.done();
});

test('--head-sha selects the matching diff version or fails clearly', async () => {
  const missing = httpMock([{ data: versions }]);
  const result = await invoke(
    [
      'mr-discussion-create',
      ...PROJECT,
      '--iid',
      '3',
      '--path',
      'src/app.js',
      '--new-line',
      '2',
      '--head-sha',
      'ffff000',
      '--body',
      'x',
    ],
    missing,
  );

  assert.equal(result.exitCode, 8);
  assert.equal(result.error.code, 'HEAD_NOT_FOUND');
  missing.done();
});

test('mr-discussion-list derives thread state and filters unresolved threads locally', async () => {
  const mock = httpMock([
    {
      data: [
        { id: 'a', notes: [{ id: 1, system: false, resolvable: false }] },
        { id: 'b', notes: [{ id: 2, resolvable: true, resolved: true }] },
        {
          id: 'c',
          notes: [
            { id: 3, resolvable: true, resolved: true },
            { id: 4, resolvable: true, resolved: false },
          ],
        },
      ],
      headers: { 'x-next-page': '' },
    },
  ]);
  const result = await invoke(
    ['mr-discussion-list', ...PROJECT, '--iid', '3', '--state', 'unresolved'],
    mock,
  );

  assert.deepEqual(
    result.output.data.map((entry) => [entry.id, entry.resolvable, entry.resolved]),
    [['c', true, false]],
  );
  assert.equal(result.output.meta.pagination.returnedCount, 1);
  mock.done();
});

test('resolving reads the thread, skips no-ops and refuses unresolvable threads', async () => {
  const thread = (resolved) => ({ id: DISCUSSION, notes: [{ id: 1, resolvable: true, resolved }] });
  const change = httpMock([
    { method: 'GET', data: thread(false) },
    {
      method: 'PUT',
      path: `${BASE}/merge_requests/3/discussions/${DISCUSSION}`,
      body: { resolved: true },
      data: thread(true),
    },
  ]);
  const same = httpMock([{ data: thread(true) }]);
  const individual = httpMock([
    { data: { id: DISCUSSION, notes: [{ id: 1, resolvable: false }] } },
  ]);
  const args = [...PROJECT, '--iid', '3', '--discussion-id', DISCUSSION];
  const resolved = await invoke(['mr-discussion-resolve', ...args], change);
  const unchanged = await invoke(['mr-discussion-resolve', ...args], same);
  const refused = await invoke(['mr-discussion-unresolve', ...args], individual);

  assert.equal(resolved.output.data.resolved, true);
  assert.equal(unchanged.output.meta.unchanged, true);
  assert.equal(refused.exitCode, 2);
  change.done();
  same.done();
  individual.done();
});

test('review-draft-create supports diff lines and thread replies', async () => {
  const line = httpMock([
    { data: versions },
    { data: version },
    {
      method: 'POST',
      path: `${BASE}/merge_requests/3/draft_notes`,
      body: { note: 'Nit', position },
      data: { id: 70 },
    },
  ]);
  const reply = httpMock([
    {
      method: 'POST',
      body: { note: 'Done', in_reply_to_discussion_id: DISCUSSION, resolve_discussion: true },
      data: { id: 71 },
    },
  ]);
  const created = await invoke(
    [
      'review-draft-create',
      ...PROJECT,
      '--iid',
      '3',
      '--path',
      'src/app.js',
      '--new-line',
      '2',
      '--body',
      'Nit',
    ],
    line,
  );
  const replied = await invoke(
    [
      'review-draft-create',
      ...PROJECT,
      '--iid',
      '3',
      '--discussion-id',
      DISCUSSION,
      '--resolve',
      '--body',
      'Done',
    ],
    reply,
  );
  const both = await invoke(
    [
      'review-draft-create',
      ...PROJECT,
      '--iid',
      '3',
      '--discussion-id',
      DISCUSSION,
      '--path',
      'a',
      '--new-line',
      '1',
      '--body',
      'x',
    ],
    httpMock([]),
  );

  assert.equal(created.output.data.id, 70);
  assert.equal(replied.output.data.id, 71);
  assert.equal(both.exitCode, 2);
  line.done();
  reply.done();
});

test('review-publish publishes every pending draft with a summary and state', async () => {
  const mock = httpMock([
    {
      path: `${BASE}/merge_requests/3/draft_notes`,
      query: { page: 1, per_page: 100 },
      data: [{ id: 70 }, { id: 71 }],
    },
    {
      method: 'POST',
      path: `${BASE}/merge_requests/3/draft_notes/bulk_publish`,
      body: { note: 'Two issues', reviewer_state: 'requested_changes' },
      response: new Response(null, { status: 204 }),
    },
  ]);
  const empty = httpMock([{ data: [] }]);
  const result = await invoke(
    [
      'review-publish',
      ...PROJECT,
      '--iid',
      '3',
      '--body',
      'Two issues',
      '--reviewer-state',
      'requested-changes',
    ],
    mock,
  );
  const nothing = await invoke(['review-publish', ...PROJECT, '--iid', '3'], empty);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.output.data, {
    iid: 3,
    publishedDraftIds: [70, 71],
    summary: true,
    reviewerState: 'requested-changes',
  });
  assert.equal(nothing.exitCode, 2);
  mock.done();
  empty.done();
});

test('review-draft-delete deletes one pending draft', async () => {
  const mock = httpMock([
    {
      method: 'DELETE',
      path: `${BASE}/merge_requests/3/draft_notes/70`,
      response: new Response(null, { status: 204 }),
    },
  ]);
  const result = await invoke(
    ['review-draft-delete', ...PROJECT, '--iid', '3', '--draft-id', '70'],
    mock,
  );

  assert.deepEqual(result.output.data, { id: 70, deleted: true });
  mock.done();
});

test('review-submit drafts inline comments, publishes them and approves the reviewed head', async () => {
  const comments = join(directory, 'comments.json');

  await writeFile(
    comments,
    JSON.stringify([{ path: 'src/app.js', body: 'Nit', line: 2, side: 'new' }]),
  );

  const mock = httpMock([
    { path: `${BASE}/merge_requests/3`, data: mr },
    { path: `${BASE}/merge_requests/3/draft_notes`, data: [] },
    { data: versions },
    { data: version },
    {
      method: 'POST',
      path: `${BASE}/merge_requests/3/draft_notes`,
      body: { note: 'Nit', position },
      data: { id: 80 },
    },
    {
      method: 'POST',
      path: `${BASE}/merge_requests/3/draft_notes/bulk_publish`,
      body: { note: 'Looks good' },
      response: new Response(null, { status: 204 }),
    },
    {
      path: `${BASE}/merge_requests/3/approvals`,
      data: { user_has_approved: false, user_can_approve: true },
    },
    {
      method: 'POST',
      path: `${BASE}/merge_requests/3/approve`,
      body: { sha: 'abcd1234' },
      data: { approved: true, user_has_approved: true },
    },
  ]);
  const result = await invoke(
    [
      'review-submit',
      ...PROJECT,
      '--iid',
      '3',
      '--event',
      'approve',
      '--body',
      'Looks good',
      '--comments-file',
      comments,
      '--head-sha',
      'abcd1234',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.output.data.publishedDraftIds, [80]);
  assert.equal(result.output.data.approval.approved, true);
  assert.equal(result.output.data.reviewerState, null);
  mock.done();
});

test('review-submit refuses stale heads and existing drafts before creating anything', async () => {
  const stale = httpMock([{ data: mr }, { data: [] }]);
  const pending = httpMock([{ data: mr }, { data: [{ id: 5 }] }]);
  const args = [...PROJECT, '--iid', '3', '--event', 'comment', '--body', 'Notes'];
  const moved = await invoke(['review-submit', ...args, '--head-sha', 'ffff000'], stale);
  const blocked = await invoke(['review-submit', ...args], pending);
  const empty = await invoke(
    ['review-submit', ...PROJECT, '--iid', '3', '--event', 'request-changes'],
    httpMock([]),
  );

  assert.equal(moved.error.code, 'HEAD_CHANGED');
  assert.equal(blocked.error.code, 'PENDING_DRAFTS');
  assert.deepEqual(blocked.error.draftIds, [5]);
  assert.equal(empty.exitCode, 2);
  stale.done();
  pending.done();
});

test('review-submit lists created drafts when a later step fails', async () => {
  const comments = join(directory, 'two.json');

  await writeFile(
    comments,
    JSON.stringify([
      { path: 'src/app.js', body: 'One', line: 2, side: 'new' },
      { path: 'src/app.js', body: 'Two', line: 1, side: 'old' },
    ]),
  );

  const mock = httpMock([
    { data: mr },
    { data: [] },
    { data: versions },
    { data: version },
    { method: 'POST', data: { id: 90 } },
    { method: 'POST', status: 400, data: { message: 'Note is invalid' } },
  ]);
  const result = await invoke(
    [
      'review-submit',
      ...PROJECT,
      '--iid',
      '3',
      '--event',
      'request-changes',
      '--comments-file',
      comments,
    ],
    mock,
  );

  assert.equal(result.exitCode, 8);
  assert.deepEqual(result.error.createdDraftIds, [90]);
  assert.match(result.error.message, /remain pending/);
  mock.done();
});
