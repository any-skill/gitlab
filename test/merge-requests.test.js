import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE, PROJECT, httpMock, invoke, textResponse } from './helpers.js';

const mr = {
  id: 300,
  iid: 3,
  draft: false,
  sha: 'abc1234def',
  state: 'opened',
  references: { full: 'group/project!3' },
};
const approvals = {
  approved: false,
  approved_by: [],
  user_has_approved: false,
  user_can_approve: true,
};

test('mr-list maps branch, user and draft filters natively', async () => {
  const mock = httpMock([
    {
      path: `${BASE}/merge_requests`,
      query: {
        state: 'opened',
        source_branch: 'feature',
        reviewer_username: 'sam',
        assignee_id: 'Any',
        draft: 'false',
        order_by: 'merged_at',
        sort: 'desc',
      },
      data: [mr],
    },
  ]);
  const result = await invoke(
    [
      'mr-list',
      ...PROJECT,
      '--source-branch',
      'feature',
      '--reviewer',
      'sam',
      '--assignee',
      'Any',
      '--drafts',
      'exclude',
      '--sort',
      'merged',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0, result.stderr);
  mock.done();
});

test('mr-create refuses an open merge request from the same branch without POST', async () => {
  const mock = httpMock([
    {
      path: `${BASE}/merge_requests`,
      query: { source_branch: 'feature', state: 'opened' },
      data: [
        { iid: 1, source_project_id: 9, target_project_id: 7, web_url: 'fork' },
        {
          iid: 2,
          source_project_id: 7,
          target_project_id: 7,
          web_url: 'https://gitlab.com/x/-/merge_requests/2',
        },
      ],
    },
  ]);
  const result = await invoke(
    [
      'mr-create',
      ...PROJECT,
      '--source-branch',
      'feature',
      '--target-branch',
      'main',
      '--title',
      'Fix',
    ],
    mock,
  );

  assert.equal(result.exitCode, 8);
  assert.equal(result.error.code, 'ALREADY_EXISTS');
  assert.equal(result.error.iid, 2);
  mock.done();
});

test('mr-create sends a draft title, reviewers and the target project of a fork', async () => {
  const mock = httpMock([
    { path: `${BASE}`, data: { id: 9 } },
    { path: '/api/v4/projects/upstream%2Fproject', data: { id: 7 } },
    {
      path: '/api/v4/projects/7/merge_requests',
      query: { source_branch: 'feature', state: 'opened' },
      data: [{ iid: 4, source_project_id: 7, target_project_id: 7 }],
    },
    { path: '/api/v4/users', query: { username: 'sam' }, data: [{ id: 11, username: 'sam' }] },
    {
      method: 'POST',
      path: `${BASE}/merge_requests`,
      body: {
        source_branch: 'feature',
        target_branch: 'main',
        title: 'Draft: Fix',
        description: 'Summary',
        reviewer_ids: [11],
        remove_source_branch: true,
        target_project_id: 7,
      },
      status: 201,
      data: { ...mr, draft: true },
    },
  ]);
  const result = await invoke(
    [
      'mr-create',
      ...PROJECT,
      '--source-branch',
      'feature',
      '--target-branch',
      'main',
      '--title',
      'Fix',
      '--description',
      'Summary',
      '--reviewer',
      'sam',
      '--draft',
      '--remove-source-branch',
      'true',
      '--target-project',
      'upstream/project',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.output.data.draft, true);
  mock.done();
});

test('mr-create maps a GitLab duplicate conflict to ALREADY_EXISTS', async () => {
  const mock = httpMock([
    { data: [] },
    {
      method: 'POST',
      status: 409,
      data: { message: ['Another open merge request already exists for this source branch: !8'] },
    },
  ]);
  const result = await invoke(
    [
      'mr-create',
      ...PROJECT,
      '--source-branch',
      'feature',
      '--target-branch',
      'main',
      '--title',
      'Draft: Fix',
      '--draft',
    ],
    mock,
  );

  assert.equal(result.error.code, 'ALREADY_EXISTS');
  assert.equal(result.error.iid, 8);
  assert.equal(mock.requests[1].body.title, 'Draft: Fix');
  mock.done();
});

test('mr-update maps state, booleans and reviewer replacement', async () => {
  const mock = httpMock([
    { path: '/api/v4/users', query: { username: 'sam' }, data: [{ id: 11, username: 'sam' }] },
    {
      method: 'PUT',
      path: `${BASE}/merge_requests/3`,
      body: {
        target_branch: 'release',
        reviewer_ids: [11],
        squash: false,
        state_event: 'close',
      },
      data: mr,
    },
  ]);
  const result = await invoke(
    [
      'mr-update',
      ...PROJECT,
      '--iid',
      '3',
      '--target-branch',
      'release',
      '--reviewer',
      'sam',
      '--squash',
      'false',
      '--state',
      'closed',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0, result.stderr);
  mock.done();
});

test('mr-draft uses the GraphQL mutation and rereads the merge request', async () => {
  const mock = httpMock([
    { path: `${BASE}/merge_requests/3`, data: mr },
    {
      method: 'POST',
      path: '/api/graphql',
      inspect({ body }) {
        assert.match(body.query, /mergeRequestSetDraft/);
        assert.deepEqual(body.variables, { projectPath: 'group/project', iid: '3', draft: true });
      },
      data: { data: { mergeRequestSetDraft: { errors: [] } } },
    },
    { path: `${BASE}/merge_requests/3`, data: { ...mr, draft: true } },
  ]);
  const unchanged = httpMock([{ data: { ...mr, draft: true } }]);
  const result = await invoke(['mr-draft', ...PROJECT, '--iid', '3'], mock);
  const same = await invoke(['mr-draft', ...PROJECT, '--iid', '3'], unchanged);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.output.data.draft, true);
  assert.equal(same.output.meta.unchanged, true);
  mock.done();
  unchanged.done();
});

test('GraphQL errors and mutation errors are reported', async () => {
  const missing = httpMock([
    { data: mr },
    {
      data: {
        data: null,
        errors: [
          {
            message:
              "The resource that you are attempting to access does not exist or you don't have permission to perform this action",
          },
        ],
      },
    },
  ]);
  const refused = httpMock([
    { data: { ...mr, draft: true } },
    { data: { data: { mergeRequestSetDraft: { errors: ['Not allowed'] } } } },
  ]);
  const notFound = await invoke(['mr-draft', ...PROJECT, '--iid', '3'], missing);
  const failed = await invoke(['mr-ready', ...PROJECT, '--iid', '3'], refused);

  assert.equal(notFound.exitCode, 5);
  assert.equal(failed.exitCode, 8);
  assert.equal(failed.error.message, 'Not allowed');
});

test('mr-diff returns a bounded unified diff inside JSON', async () => {
  const mock = httpMock([
    {
      path: `${BASE}/merge_requests/3/raw_diffs`,
      response: textResponse('diff --git a/x b/x\n+ä\n'),
    },
  ]);
  const result = await invoke(['mr-diff', ...PROJECT, '--iid', '3', '--max-bytes', '20'], mock);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.output.data.diff, 'diff --git a/x b/x\n+');
  assert.equal(result.output.data.truncated, true);
  assert.equal(result.output.data.returnedBytes, 20);
  mock.done();
});

test('mr-approve binds the approval to the observed head SHA', async () => {
  const mock = httpMock([
    { path: `${BASE}/merge_requests/3/approvals`, data: approvals },
    { path: `${BASE}/merge_requests/3`, data: mr },
    {
      method: 'POST',
      path: `${BASE}/merge_requests/3/approve`,
      body: { sha: 'abc1234def' },
      status: 201,
      data: { ...approvals, approved: true, user_has_approved: true },
    },
  ]);
  const result = await invoke(['mr-approve', ...PROJECT, '--iid', '3'], mock);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.output.data.userHasApproved, true);
  assert.equal(result.output.meta.approvedSha, 'abc1234def');
  mock.done();
});

test('mr-approve reports unchanged, refusal and a moved head distinctly', async () => {
  const already = httpMock([
    { data: { ...approvals, user_has_approved: true } },
    { path: `${BASE}/merge_requests/3`, data: mr },
  ]);
  // An approval that survived a push does not cover a reviewed SHA that is not the head.
  const survived = httpMock([
    { data: { ...approvals, user_has_approved: true } },
    { data: { ...mr, sha: 'fedcba9876' } },
  ]);
  // userCanApprove=false is advisory; the refusal comes from the approve endpoint.
  const refused = httpMock([
    { data: { ...approvals, user_can_approve: false } },
    { method: 'POST', status: 401, data: { message: '401 Unauthorized' } },
  ]);
  const moved = httpMock([
    { data: approvals },
    { method: 'POST', status: 409, data: { message: 'SHA does not match HEAD of source branch' } },
  ]);
  const unchanged = await invoke(
    ['mr-approve', ...PROJECT, '--iid', '3', '--sha', 'abc1234'],
    already,
  );
  const denied = await invoke(
    ['mr-approve', ...PROJECT, '--iid', '3', '--sha', 'abc1234'],
    refused,
  );
  const stale = await invoke(['mr-approve', ...PROJECT, '--iid', '3', '--sha', 'abc1234'], moved);
  const outdated = await invoke(
    ['mr-approve', ...PROJECT, '--iid', '3', '--sha', 'abc1234'],
    survived,
  );

  assert.equal(unchanged.output.meta.unchanged, true);
  assert.equal(denied.exitCode, 4);
  assert.equal(denied.error.code, 'PERMISSION_DENIED');
  assert.equal(stale.exitCode, 8);
  assert.equal(stale.error.code, 'HEAD_CHANGED');
  assert.equal(outdated.error.code, 'HEAD_CHANGED');
  assert.equal(outdated.error.alreadyApproved, true);
  assert.equal(outdated.error.headSha, 'fedcba9876');
  already.done();
  refused.done();
  moved.done();
  survived.done();
});

test('mr-unapprove only writes when the user had approved', async () => {
  const approved = httpMock([
    { data: { ...approvals, user_has_approved: true } },
    { method: 'POST', path: `${BASE}/merge_requests/3/unapprove`, status: 201, data: approvals },
  ]);
  const none = httpMock([{ data: approvals }]);
  const removed = await invoke(['mr-unapprove', ...PROJECT, '--iid', '3'], approved);
  const unchanged = await invoke(['mr-unapprove', ...PROJECT, '--iid', '3'], none);

  assert.equal(removed.output.data.userHasApproved, false);
  assert.equal(unchanged.output.meta.unchanged, true);
  approved.done();
  none.done();
});
