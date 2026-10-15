import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE, PROJECT, httpMock, invoke } from './helpers.js';

const issue = { id: 100, iid: 12, title: 'Bug', state: 'opened', labels: [] };
const DISCUSSION = '0123456789abcdef0123456789abcdef01234567';

test('issue-list maps filters to native GitLab parameters', async () => {
  const mock = httpMock([
    {
      method: 'GET',
      path: `${BASE}/issues`,
      query: {
        state: 'closed',
        updated_after: '2026-01-01T00:00:00Z',
        labels: 'bug,ui',
        assignee_id: 'None',
        author_username: 'alex',
        search: 'crash',
        order_by: 'updated_at',
        sort: 'asc',
        page: 1,
        per_page: 50,
      },
      data: [issue],
    },
  ]);
  const result = await invoke(
    [
      'issue-list',
      ...PROJECT,
      '--state',
      'closed',
      '--since',
      '2026-01-01T00:00:00Z',
      '--label',
      'bug',
      '--label',
      'ui',
      '--assignee',
      'None',
      '--author',
      'alex',
      '--search',
      'crash',
      '--sort',
      'updated',
      '--direction',
      'asc',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.output.data[0].iid, 12);
  mock.done();
});

test('issue-list omits the state for all and filters an assignee by username', async () => {
  const mock = httpMock([
    { query: { state: undefined, assignee_username: 'alex', assignee_id: undefined }, data: [] },
  ]);
  const result = await invoke(
    ['issue-list', ...PROJECT, '--state', 'all', '--assignee', 'alex'],
    mock,
  );

  assert.equal(result.exitCode, 0, result.stderr);
  mock.done();
});

test('issue-create resolves usernames to IDs and sends labels as one value', async () => {
  const mock = httpMock([
    { path: '/api/v4/users', query: { username: 'alex' }, data: [{ id: 5, username: 'Alex' }] },
    {
      method: 'POST',
      path: `${BASE}/issues`,
      body: {
        title: 'Fix startup',
        description: 'Steps',
        labels: 'bug,ui',
        assignee_ids: [5],
        milestone: 'v1',
        due_date: '2026-12-31',
        confidential: true,
      },
      status: 201,
      data: issue,
    },
  ]);
  const result = await invoke(
    [
      'issue-create',
      ...PROJECT,
      '--title',
      'Fix startup',
      '--description',
      'Steps',
      '--label',
      'bug',
      '--label',
      'ui',
      '--assignee',
      '@alex',
      '--milestone',
      'v1',
      '--due-date',
      '2026-12-31',
      '--confidential',
      'true',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.output.data.iid, 12);
  mock.done();
});

test('issue-create refuses unknown users, comma labels and quick actions before writing', async () => {
  const unknown = httpMock([{ path: '/api/v4/users', data: [] }]);
  const cases = [
    [['--assignee', 'ghost'], unknown],
    [['--label', 'a,b'], httpMock([])],
    [['--description', 'Text\n/close'], httpMock([])],
    [['--title', 'x'.repeat(256)], httpMock([])],
  ];

  for (const [args, mock] of cases) {
    const result = await invoke(['issue-create', ...PROJECT, '--title', 'Fix', ...args], mock);

    assert.equal(result.exitCode, 2, JSON.stringify(args));
    mock.done();
  }
});

test('issue-update supports incremental labels and explicit clearing', async () => {
  const mock = httpMock([
    {
      method: 'PUT',
      path: `${BASE}/issues/12`,
      body: {
        add_labels: 'review',
        remove_labels: 'triage',
        assignee_ids: [],
        milestone_id: 0,
        due_date: '',
        confidential: false,
      },
      data: issue,
    },
  ]);
  const result = await invoke(
    [
      'issue-update',
      ...PROJECT,
      '--iid',
      '12',
      '--add-label',
      'review',
      '--remove-label',
      'triage',
      '--clear-assignees',
      '--clear-milestone',
      '--clear-due-date',
      '--confidential',
      'false',
    ],
    mock,
  );
  const empty = await invoke(['issue-update', ...PROJECT, '--iid', '12'], httpMock([]));

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(empty.exitCode, 2);
  mock.done();
});

test('issue-update can clear the description and every label', async () => {
  const mock = httpMock([{ body: { description: '', labels: '' }, data: issue }]);
  const result = await invoke(
    ['issue-update', ...PROJECT, '--iid', '12', '--description', '', '--clear-labels'],
    mock,
  );

  assert.equal(result.exitCode, 0, result.stderr);
  mock.done();
});

for (const [name, from, to, event] of [
  ['issue-close', 'opened', 'closed', 'close'],
  ['issue-reopen', 'closed', 'opened', 'reopen'],
]) {
  test(`${name} reads the state and only writes when it changes`, async () => {
    const change = httpMock([
      { method: 'GET', data: { ...issue, state: from } },
      { method: 'PUT', body: { state_event: event }, data: { ...issue, state: to } },
    ]);
    const same = httpMock([{ method: 'GET', data: { ...issue, state: to } }]);
    const changed = await invoke([name, ...PROJECT, '--iid', '12'], change);
    const unchanged = await invoke([name, ...PROJECT, '--iid', '12'], same);

    assert.equal(changed.output.data.state, to);
    assert.equal(changed.output.meta.unchanged, undefined);
    assert.equal(unchanged.output.meta.unchanged, true);
    change.done();
    same.done();
  });
}

test('note lists read in order and filter system notes and --since locally', async () => {
  const mock = httpMock([
    {
      path: `${BASE}/issues/12/notes`,
      query: { order_by: 'created_at', sort: 'asc' },
      data: [
        { id: 1, system: true, updated_at: '2026-01-02T00:00:00Z' },
        { id: 2, system: false, updated_at: '2025-12-31T00:00:00Z' },
        { id: 3, system: false, updated_at: '2026-01-02T00:00:00Z' },
      ],
    },
  ]);
  const result = await invoke(
    [
      'issue-note-list',
      ...PROJECT,
      '--iid',
      '12',
      '--system',
      'exclude',
      '--since',
      '2026-01-01T00:00:00Z',
    ],
    mock,
  );

  assert.deepEqual(
    result.output.data.map((note) => note.id),
    [3],
  );
  assert.equal(result.output.meta.pagination.returnedCount, 1);
  mock.done();
});

test('note-create posts the body and reports a quick-action-only answer', async () => {
  const note = httpMock([
    {
      method: 'POST',
      path: `${BASE}/merge_requests/3/notes`,
      body: { body: 'Looks good', internal: true },
      status: 201,
      data: { id: 9, body: 'Looks good' },
    },
  ]);
  const commands = httpMock([
    { status: 202, data: { commands_changes: { state_event: 'close' }, summary: ['Closed'] } },
  ]);
  const created = await invoke(
    ['mr-note-create', ...PROJECT, '--iid', '3', '--body', 'Looks good', '--internal'],
    note,
  );
  const quick = await invoke(
    ['mr-note-create', ...PROJECT, '--iid', '3', '--body', '/close', '--allow-quick-actions'],
    commands,
  );

  assert.equal(created.output.data.id, 9);
  assert.deepEqual(created.output.meta.quickActionsOnly, undefined);
  assert.equal(quick.output.meta.quickActionsOnly, true);
  assert.deepEqual(quick.output.data.commandsChanges, { stateEvent: 'close' });
  note.done();
  commands.done();
});

test('issue discussions are listed, filtered and replied to by thread ID', async () => {
  const list = httpMock([
    {
      path: `${BASE}/issues/12/discussions`,
      data: [
        { id: 'a', notes: [{ id: 1, system: true }] },
        { id: 'b', notes: [{ id: 2, system: false }] },
      ],
    },
  ]);
  const reply = httpMock([
    {
      method: 'POST',
      path: `${BASE}/issues/12/discussions/${DISCUSSION}/notes`,
      body: { body: 'Answered' },
      status: 201,
      data: { id: 3 },
    },
  ]);
  const listed = await invoke(
    ['issue-discussion-list', ...PROJECT, '--iid', '12', '--system', 'exclude'],
    list,
  );
  const replied = await invoke(
    [
      'issue-discussion-reply',
      ...PROJECT,
      '--iid',
      '12',
      '--discussion-id',
      DISCUSSION,
      '--body',
      'Answered',
    ],
    reply,
  );

  assert.deepEqual(
    listed.output.data.map((entry) => entry.id),
    ['b'],
  );
  assert.equal(listed.output.data[0].resolvable, undefined);
  assert.equal(replied.output.data.id, 3);
  list.done();
  reply.done();
});
