import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE, PROJECT, httpMock, invoke, textResponse } from './helpers.js';

const log = 'line1\n\u001b[32;1mline2\u001b[0;m\nline3\nERROR: Job failed\n';

test('pipeline-list and job-list map filters, including array scopes', async () => {
  const pipelines = httpMock([
    {
      path: `${BASE}/pipelines`,
      query: { ref: 'main', status: 'failed', updated_after: '2026-01-01T00:00:00Z' },
      data: [{ id: 1, status: 'failed' }],
    },
  ]);
  const jobs = httpMock([
    {
      path: `${BASE}/pipelines/1/jobs`,
      query: { 'scope[]': ['failed', 'canceled'], include_retried: 'true' },
      data: [{ id: 2, status: 'failed', allow_failure: false }],
    },
  ]);
  const listed = await invoke(
    [
      'pipeline-list',
      ...PROJECT,
      '--ref',
      'main',
      '--status',
      'failed',
      '--since',
      '2026-01-01T00:00:00Z',
    ],
    pipelines,
  );
  const failed = await invoke(
    [
      'job-list',
      ...PROJECT,
      '--pipeline-id',
      '1',
      '--scope',
      'failed',
      '--scope',
      'canceled',
      '--include-retried',
    ],
    jobs,
  );

  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.equal(failed.output.data[0].allowFailure, false);
  pipelines.done();
  jobs.done();
});

test('job-log reads the tail with a range request and drops the partial first line', async () => {
  const mock = httpMock([
    {
      path: `${BASE}/jobs/9/trace`,
      inspect({ init }) {
        assert.equal(init.headers.range, 'bytes=-26');
      },
      response: textResponse('2\nline3\nERROR: Job failed\n', 206, {
        'content-range': 'bytes 10-35/36',
      }),
    },
  ]);
  const result = await invoke(
    ['job-log', ...PROJECT, '--job-id', '9', '--max-bytes', '26', '--max-lines', '5'],
    mock,
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.output.data, {
    jobId: 9,
    from: 'tail',
    text: 'line3\nERROR: Job failed',
    truncated: true,
    returnedLines: 2,
  });
  mock.done();
});

test('job-log handles servers without range support, empty logs and the head', async () => {
  const full = httpMock([{ response: textResponse(log) }]);
  const empty = httpMock([{ response: new Response(null, { status: 416 }) }]);
  const head = httpMock([
    {
      inspect({ init }) {
        assert.equal(init.headers.range, undefined);
      },
      response: textResponse(log),
    },
  ]);
  const tail = await invoke(['job-log', ...PROJECT, '--job-id', '9', '--max-lines', '2'], full);
  const nothing = await invoke(['job-log', ...PROJECT, '--job-id', '9'], empty);
  const start = await invoke(
    ['job-log', ...PROJECT, '--job-id', '9', '--from', 'head', '--max-lines', '2'],
    head,
  );

  assert.deepEqual(
    [tail.output.data.text, tail.output.data.truncated],
    ['line3\nERROR: Job failed', true],
  );
  assert.deepEqual([nothing.output.data.text, nothing.output.data.returnedLines], ['', 0]);
  assert.deepEqual([start.output.data.text, start.output.data.truncated], ['line1\nline2', true]);
  full.done();
  empty.done();
  head.done();
});

test('job-log maps a missing log to NOT_FOUND', async () => {
  const mock = httpMock([{ status: 404, data: { message: '404 Not found' } }]);
  const result = await invoke(['job-log', ...PROJECT, '--job-id', '9'], mock);

  assert.equal(result.exitCode, 5);
  mock.done();
});

test('mr-checks summarizes the head pipeline, its jobs and trigger jobs', async () => {
  const mock = httpMock([
    {
      path: `${BASE}/merge_requests/3`,
      data: {
        iid: 3,
        sha: 'head',
        detailed_merge_status: 'ci_still_running',
        head_pipeline: { id: 40, sha: 'old', status: 'success' },
      },
    },
    {
      path: `${BASE}/merge_requests/3/pipelines`,
      query: { page: 1, per_page: 100 },
      data: [
        { id: 41, sha: 'head', status: 'failed', source: 'push' },
        { id: 42, sha: 'head', status: 'running', source: 'merge_request_event' },
        { id: 40, sha: 'old', status: 'success' },
      ],
    },
    {
      path: `${BASE}/pipelines/42/jobs`,
      data: [
        { id: 1, name: 'lint', status: 'failed', allow_failure: true },
        { id: 2, name: 'test', status: 'running', allow_failure: false },
        { id: 3, name: 'deploy', status: 'manual', allow_failure: true },
      ],
    },
    {
      path: `${BASE}/pipelines/42/trigger_jobs`,
      data: [
        {
          id: 4,
          name: 'child',
          status: 'success',
          downstream_pipeline: { id: 50, status: 'success' },
        },
      ],
    },
  ]);
  const result = await invoke(['mr-checks', ...PROJECT, '--iid', '3'], mock);
  const { data } = result.output;

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(data.state, 'running');
  assert.equal(data.pipeline.id, 42);
  assert.deepEqual(
    data.pipelines.map((pipeline) => pipeline.id),
    [41, 42],
  );
  assert.deepEqual(
    data.items.map((item) => [item.type, item.name, item.category]),
    [
      ['job', 'lint', 'warning'],
      ['job', 'test', 'running'],
      ['job', 'deploy', 'manual'],
      ['trigger-job', 'child', 'successful'],
    ],
  );
  assert.equal(data.items[3].downstreamPipeline.id, 50);
  mock.done();
});

test('mr-checks reports no-checks without pipelines and a failed head pipeline as data', async () => {
  const none = httpMock([{ data: { iid: 3, sha: 'head', head_pipeline: null } }, { data: [] }]);
  const failed = httpMock([
    { data: { iid: 3, sha: 'head', head_pipeline: { id: 7, sha: 'head', status: 'failed' } } },
    { data: [] },
    { data: [{ id: 1, name: 'test', status: 'failed', allow_failure: false }] },
    { data: [] },
  ]);
  const empty = await invoke(['mr-checks', ...PROJECT, '--iid', '3'], none);
  const red = await invoke(['mr-checks', ...PROJECT, '--iid', '3'], failed);

  assert.equal(empty.output.data.state, 'no-checks');
  assert.equal(empty.output.data.pipeline, null);
  assert.equal(red.exitCode, 0);
  assert.equal(red.output.data.state, 'failed');
  assert.equal(red.output.data.items[0].category, 'failed');
  none.done();
  failed.done();
});

test('trigger-job-list falls back to bridges only for a missing route', async () => {
  const old = httpMock([
    { path: `${BASE}/pipelines/5/trigger_jobs`, status: 404, data: { error: '404 Not Found' } },
    { path: `${BASE}/pipelines/5/bridges`, data: [{ id: 6 }] },
  ]);
  const missing = httpMock([{ status: 404, data: { message: '404 Pipeline Not Found' } }]);
  const fallback = await invoke(['trigger-job-list', ...PROJECT, '--pipeline-id', '5'], old);
  const notFound = await invoke(['trigger-job-list', ...PROJECT, '--pipeline-id', '5'], missing);

  assert.equal(fallback.output.data[0].id, 6);
  assert.equal(notFound.exitCode, 5);
  old.done();
  missing.done();
});

test('pipeline-test-report can keep only failed cases', async () => {
  const mock = httpMock([
    {
      path: `${BASE}/pipelines/5/test_report`,
      data: {
        total_count: 3,
        failed_count: 1,
        test_suites: [
          {
            name: 'unit',
            test_cases: [
              { name: 'a', status: 'success' },
              { name: 'b', status: 'failed', stack_trace: 'boom' },
            ],
          },
          { name: 'lint', test_cases: [{ name: 'c', status: 'success' }] },
        ],
      },
    },
  ]);
  const result = await invoke(
    ['pipeline-test-report', ...PROJECT, '--pipeline-id', '5', '--failed-only'],
    mock,
  );

  assert.deepEqual(result.output.data.testSuites, [
    { name: 'unit', testCases: [{ name: 'b', status: 'failed', stackTrace: 'boom' }] },
  ]);
  assert.equal(result.output.data.totalCount, 3);
  mock.done();
});

test('commit statuses and retries call the documented endpoints', async () => {
  const mock = httpMock([
    {
      path: `${BASE}/repository/commits/abc1234/statuses`,
      query: { all: 'true', name: 'test' },
      data: [{ id: 1, name: 'test', status: 'failed' }],
    },
    {
      method: 'POST',
      path: `${BASE}/jobs/9/retry`,
      status: 201,
      data: { id: 10, status: 'pending' },
    },
    {
      method: 'POST',
      path: `${BASE}/pipelines/5/retry`,
      status: 201,
      data: { id: 5, status: 'running' },
    },
  ]);
  const statuses = await invoke(
    ['commit-status-list', ...PROJECT, '--sha', 'abc1234', '--name', 'test', '--include-history'],
    mock,
  );
  const job = await invoke(['job-retry', ...PROJECT, '--job-id', '9'], mock);
  const pipeline = await invoke(['pipeline-retry', ...PROJECT, '--pipeline-id', '5'], mock);

  assert.equal(statuses.output.data[0].status, 'failed');
  assert.equal(job.output.data.id, 10);
  assert.equal(pipeline.output.data.status, 'running');
  mock.done();
});
