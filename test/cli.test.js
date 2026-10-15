import test from 'node:test';
import assert from 'node:assert/strict';
import pkg from '../package.json' with { type: 'json' };
import { BASE, PROJECT, TOKEN, httpMock, invoke, jsonResponse } from './helpers.js';

const NEXT = { 'x-next-page': '2', 'x-total': '2', 'x-total-pages': '2' };
const LAST = { 'x-next-page': '', 'x-total': '2', 'x-total-pages': '2' };

test('help and version need no token', async () => {
  const help = await invoke(['issue-get', '--help'], undefined, { env: {} });
  const general = await invoke(['--help'], undefined, { env: {} });
  const version = await invoke(['--version'], undefined, { env: {} });

  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /--iid <value> \(required; range: 1\+\)/);
  assert.match(general.stdout, /GITLAB_HOST/);
  assert.equal(version.exitCode, 0);
  assert.equal(version.stdout, `${pkg.version}\n`);
});

for (const args of [
  [],
  ['missing-command'],
  ['issue-get', 'extra'],
  ['issue-get', ...PROJECT],
  ['issue-get', ...PROJECT, '--iid', '0'],
  ['issue-get', ...PROJECT, '--iid', '1.5'],
  ['issue-get', ...PROJECT, '--iid', '1', '--iid', '2'],
  ['issue-list', ...PROJECT, '--iid', '1'],
  ['issue-list', ...PROJECT, '--per-page', '101'],
  ['issue-list', ...PROJECT, '--state', 'merged'],
  ['issue-list', ...PROJECT, '--since', '2026-01-01'],
  ['issue-list', ...PROJECT, '--unknown'],
  ['issue-list', ...PROJECT, '--all', '--if-none-match', 'W/"x"'],
  ['issue-create', ...PROJECT, '--title', ''],
  ['issue-update', ...PROJECT, '--iid', '1', '--label', 'a', '--clear-labels'],
  ['issue-update', ...PROJECT, '--iid', '1', '--due-date', '2026-1-1'],
  ['mr-note-create', ...PROJECT, '--iid', '1', '--body', 'x', '--body-file', 'note.md'],
  ['mr-discussion-get', ...PROJECT, '--iid', '1', '--discussion-id', 'abc'],
  ['mr-discussion-create', ...PROJECT, '--iid', '1', '--new-line', '1', '--old-line', '2'],
  ['commit-get', ...PROJECT, '--sha', 'not-a-sha'],
  ['job-list', ...PROJECT, '--pipeline-id', '1', '--scope', 'broken'],
  ['issue-get', '--project', 'single-segment', '--iid', '1'],
  ['issue-get', '--project', 'https://example.com/group/project', '--iid', '1'],
]) {
  test(`invalid arguments ${JSON.stringify(args)} exit 2 without a request`, async () => {
    const mock = httpMock([]);
    const result = await invoke(args, mock);

    assert.equal(result.exitCode, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
    assert.equal(mock.requests.length, 0);
  });
}

test('a missing token exits 3 and an invalid GITLAB_HOST exits 2, both before any request', async () => {
  const mock = httpMock([]);
  const missing = await invoke(['project-get', ...PROJECT], mock, { env: {} });
  const insecure = await invoke(['project-get', ...PROJECT], mock, {
    env: { GITLAB_TOKEN: TOKEN, GITLAB_HOST: 'http://gitlab.example.com' },
  });

  assert.equal(missing.exitCode, 3);
  assert.equal(missing.error.code, 'TOKEN_REQUIRED');
  assert.equal(insecure.exitCode, 2);
  assert.equal(mock.requests.length, 0);
});

test('success is one JSON envelope with camelCase keys, metadata and the token redacted', async () => {
  const mock = httpMock([
    {
      method: 'GET',
      path: BASE,
      data: { id: 7, default_branch: 'main', _links: { self: 'x' }, note: `Echoed ${TOKEN}` },
      headers: {
        'ratelimit-limit': '2000',
        'ratelimit-remaining': '1999',
        'ratelimit-reset': '1800000000',
        'ratelimit-name': 'throttle_authenticated_api',
        etag: 'W/"abc"',
      },
      inspect({ init }) {
        assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
        assert.match(init.headers['user-agent'], /^any-skill-gitlab\//);
        assert.equal(init.redirect, 'manual');
      },
    },
  ]);
  const result = await invoke(['project-get', ...PROJECT], mock);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.equal(result.output.schemaVersion, 1);
  assert.equal(result.output.data.defaultBranch, 'main');
  assert.deepEqual(result.output.data._links, { self: 'x' });
  assert.equal(result.output.data.note, 'Echoed [REDACTED]');
  assert.equal(result.output.meta.command, 'project-get');
  assert.equal(result.output.meta.host, 'https://gitlab.com');
  assert.equal(result.output.meta.project, 'group/project');
  assert.equal(result.output.meta.etag, 'W/"abc"');
  assert.deepEqual(result.output.meta.rateLimit, {
    limit: 2000,
    remaining: 1999,
    resetAt: '2027-01-15T08:00:00.000Z',
    name: 'throttle_authenticated_api',
  });
  mock.done();
});

test('GITLAB_HOST with a relative URL root selects the API of that instance', async () => {
  const mock = httpMock([{ path: '/gitlab/api/v4/projects/42', data: { id: 42 } }]);
  const result = await invoke(['project-get', '--project', '42'], mock, {
    env: { GITLAB_TOKEN: TOKEN, GITLAB_HOST: 'https://code.example.com/gitlab/' },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.output.meta.host, 'https://code.example.com/gitlab');
  assert.equal(mock.requests[0].url.origin, 'https://code.example.com');
  mock.done();
});

test('one page reports how to continue from x-next-page', async () => {
  const mock = httpMock([
    { path: `${BASE}/issues`, query: { page: 1, per_page: 50 }, data: [{ id: 1 }], headers: NEXT },
  ]);
  const result = await invoke(['issue-list', ...PROJECT], mock);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.output.meta.pagination, {
    page: 1,
    perPage: 50,
    hasNextPage: true,
    nextPage: 2,
    totalCount: 2,
    totalPages: 2,
    returnedCount: 1,
    complete: false,
  });
  mock.done();
});

test('--all reads every remaining page, and Link headers work without x-next-page', async () => {
  const mock = httpMock([
    { query: { page: 1, per_page: 1 }, data: [{ id: 1 }], headers: NEXT },
    {
      query: { page: 2 },
      data: [{ id: 2 }],
      headers: { link: `<https://gitlab.com${BASE}/issues?page=3&per_page=1>; rel="next"` },
    },
    { query: { page: 3 }, data: [{ id: 3 }], headers: LAST },
  ]);
  const result = await invoke(['issue-list', ...PROJECT, '--all', '--per-page', '1'], mock);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(
    result.output.data.map((item) => item.id),
    [1, 2, 3],
  );
  assert.equal(result.output.meta.pagination.page, 3);
  assert.equal(result.output.meta.pagination.complete, true);
  mock.done();
});

test('a failed later page discards the partial list', async () => {
  const mock = httpMock([
    { data: [{ id: 1 }], headers: NEXT },
    { status: 403, data: { message: '403 Forbidden' } },
  ]);
  const result = await invoke(['issue-list', ...PROJECT, '--all'], mock);

  assert.equal(result.exitCode, 4);
  assert.equal(result.stdout, '');
  mock.done();
});

for (const [status, data, headers, code, exitCode] of [
  [401, { message: '401 Unauthorized' }, {}, 'AUTHENTICATION_FAILED', 3],
  [403, { message: '403 Forbidden' }, {}, 'PERMISSION_DENIED', 4],
  [404, { message: '404 Project Not Found' }, {}, 'NOT_FOUND', 5],
  [409, { message: ['Conflict happened'] }, {}, 'API_ERROR', 8],
  [422, { message: { title: ["can't be blank"] } }, {}, 'API_ERROR', 8],
  [
    429,
    { message: 'Retry later' },
    { 'retry-after': '30', 'ratelimit-reset': '1800000000' },
    'RATE_LIMITED',
    6,
  ],
  [500, { message: `Failure ${TOKEN}` }, { 'x-request-id': 'req-1' }, 'API_ERROR', 8],
]) {
  test(`HTTP ${status} exits ${exitCode} with ${code}`, async () => {
    const mock = httpMock([{ status, data, headers }]);
    const result = await invoke(['project-get', ...PROJECT], mock);

    assert.equal(result.exitCode, exitCode);
    assert.equal(result.error.code, code);
    assert.equal(result.error.status, status);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(TOKEN));
    if (status === 404) {
      assert.equal(result.error.reason, '404 Project Not Found');
    }
    if (status === 422) {
      assert.equal(result.error.message, "title can't be blank");
    }
    if (status === 429) {
      assert.equal(result.error.retryAfterSeconds, 30);
      assert.equal(result.error.resetAt, '2027-01-15T08:00:00.000Z');
    }
    if (status === 500) {
      assert.equal(result.error.requestId, 'req-1');
    }
    mock.done();
  });
}

test('an insufficient token scope is a permission failure that names the scope', async () => {
  const mock = httpMock([
    {
      status: 403,
      data: { error: 'insufficient_scope', error_description: 'Higher privileges', scope: 'api' },
    },
  ]);
  const result = await invoke(['project-get', ...PROJECT], mock);

  assert.equal(result.exitCode, 4);
  assert.equal(result.error.code, 'PERMISSION_DENIED');
  assert.equal(result.error.requiredScope, 'api');
});

test('network failures and timeouts exit 7', async () => {
  for (const failure of [
    new TypeError('fetch failed'),
    Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }),
  ]) {
    const result = await invoke(['project-get', ...PROJECT], {
      fetch: async () => {
        throw failure;
      },
    });

    assert.equal(result.exitCode, 7);
    assert.equal(result.error.code, 'NETWORK_ERROR');
  }
});

test('a conditional request returns notModified on HTTP 304', async () => {
  const mock = httpMock([
    {
      response: jsonResponse(null, 304, { etag: 'W/"same"' }),
      inspect({ init }) {
        assert.equal(init.headers['if-none-match'], 'W/"same"');
      },
    },
  ]);
  const result = await invoke(
    ['mr-get', ...PROJECT, '--iid', '3', '--if-none-match', 'W/"same"'],
    mock,
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.output.data, null);
  assert.equal(result.output.meta.notModified, true);
  assert.equal(result.output.meta.etag, 'W/"same"');
  mock.done();
});

test('same-origin GET redirects are followed and other redirects are refused', async () => {
  const moved = httpMock([
    { status: 301, data: {}, headers: { location: 'https://gitlab.com/api/v4/projects/81' } },
    { path: '/api/v4/projects/81', data: { id: 81 } },
  ]);
  const elsewhere = httpMock([
    { status: 302, data: {}, headers: { location: 'https://attacker.example/api/v4/projects/81' } },
  ]);

  const followed = await invoke(['project-get', ...PROJECT], moved);
  const refused = await invoke(['project-get', ...PROJECT], elsewhere);

  assert.equal(followed.exitCode, 0, followed.stderr);
  assert.equal(followed.output.data.id, 81);
  assert.equal(moved.requests[1].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(refused.exitCode, 8);
  assert.equal(refused.error.code, 'UNEXPECTED_REDIRECT');
  moved.done();
  elsewhere.done();
});
