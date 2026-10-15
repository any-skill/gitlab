import {
  command,
  conditional,
  flag,
  integer,
  jobId,
  mrIid,
  paging,
  pipelineId,
  sha,
  since,
  string,
} from '../options.js';
import { concurrently } from '../client.js';
import { logText, readHead, readTail } from '../log.js';
import { getMergeRequest, mrPath } from './common.js';

const group = 'CI/CD';
const PIPELINE_STATUSES = [
  'created',
  'waiting_for_resource',
  'preparing',
  'waiting_for_callback',
  'pending',
  'running',
  'success',
  'failed',
  'canceling',
  'canceled',
  'skipped',
  'manual',
  'scheduled',
];
const pipelineResult =
  'data: pipeline with id, iid, status, source, ref, sha, createdAt, updatedAt, startedAt, finishedAt, duration and webUrl.';
const jobResult =
  'data: job with id, name, stage, status, allowFailure, failureReason, pipeline, ref, createdAt, startedAt, finishedAt, duration and webUrl.';
const listResult = 'data: resource array; meta.pagination describes remaining pages.';
const scope = {
  scope: string('Only jobs with this status; repeatable.', {
    multiple: true,
    choices: PIPELINE_STATUSES,
  }),
};
const PENDING = [
  'created',
  'waiting_for_resource',
  'preparing',
  'waiting_for_callback',
  'pending',
  'scheduled',
];

export function jobCategory(job) {
  if (job.status === 'failed') {
    return job.allowFailure ? 'warning' : 'failed';
  }
  if (['canceled', 'canceling'].includes(job.status)) {
    return 'canceled';
  }
  if (job.status === 'success') {
    return 'successful';
  }
  if (job.status === 'running') {
    return 'running';
  }
  if (PENDING.includes(job.status)) {
    return 'pending';
  }

  return ['manual', 'skipped'].includes(job.status) ? job.status : 'unknown';
}

// The aggregate follows the pipeline status GitLab uses for merge checks.
export function pipelineState(pipeline) {
  if (!pipeline) {
    return 'no-checks';
  }

  const category = jobCategory({ status: pipeline.status, allowFailure: false });

  return category === 'warning' ? 'failed' : category;
}

function compactPipeline(pipeline) {
  return pipeline
    ? {
        id: pipeline.id,
        iid: pipeline.iid,
        status: pipeline.status,
        source: pipeline.source,
        ref: pipeline.ref,
        sha: pipeline.sha,
        createdAt: pipeline.createdAt,
        updatedAt: pipeline.updatedAt,
        webUrl: pipeline.webUrl,
      }
    : null;
}

function compactJob(job, type) {
  const item = {
    type,
    id: job.id,
    name: job.name,
    stage: job.stage,
    status: job.status,
    allowFailure: job.allowFailure,
    failureReason: job.failureReason ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    webUrl: job.webUrl,
    category: jobCategory(job),
  };

  if (type === 'trigger-job') {
    item.downstreamPipeline = compactPipeline(job.downstreamPipeline);
  }

  return item;
}

// Trigger jobs were called bridges before GitLab 19.2; an unknown route (not a missing
// pipeline) falls back to the old name on older instances.
async function triggerJobs(ctx, id, query) {
  try {
    return await ctx.list(ctx.projectPath(`/pipelines/${id}/trigger_jobs`), query);
  } catch (error) {
    if (error.status === 404 && error.body?.error === '404 Not Found') {
      return ctx.list(ctx.projectPath(`/pipelines/${id}/bridges`), query);
    }

    throw error;
  }
}

async function jobLog(ctx, opts) {
  const path = ctx.projectPath(`/jobs/${opts['job-id']}/trace`);
  const maxBytes = opts['max-bytes'];
  let read;

  if (opts.from === 'head') {
    const response = await ctx.stream(path);

    read = await readHead(response.body, maxBytes, opts['max-lines']);
  } else {
    // A suffix range downloads only the end of a long log; servers without range support
    // answer 200 and the tail is cut locally.
    const response = await ctx.stream(path, { range: `bytes=-${maxBytes}` });

    if (response.status === 416) {
      await response.body?.cancel();
      read = { bytes: Buffer.alloc(0), truncated: false };
    } else if (response.status === 206) {
      const range = response.headers.get('content-range')?.match(/^bytes (\d+)-\d+\/(\d+|\*)$/);

      read = await readTail(response.body, maxBytes);
      read.truncated = Number(range?.[1] ?? 0) > 0;
    } else {
      read = await readTail(response.body, maxBytes);
    }
  }

  return {
    data: {
      jobId: opts['job-id'],
      from: opts.from,
      ...logText(read.bytes, {
        from: opts.from,
        truncated: read.truncated,
        maxLines: opts['max-lines'],
        raw: opts.raw,
      }),
    },
    meta: {},
  };
}

async function mrChecks(ctx, opts) {
  const all = ctx.withOptions({ all: true, page: 1, 'per-page': 100 });
  const [current, pipelines] = await concurrently(
    getMergeRequest(ctx, opts.iid),
    all.list(mrPath(ctx, opts.iid, '/pipelines')),
  );
  const headSha = current.data.sha;
  const forHead = pipelines.data.filter((pipeline) => pipeline.sha === headSha);
  const head = current.data.headPipeline;
  const selected =
    head?.sha === headSha
      ? head
      : (forHead.toSorted((first, second) => second.id - first.id)[0] ?? null);
  let items = [];

  if (selected) {
    const [jobs, triggers] = await concurrently(
      all.list(ctx.projectPath(`/pipelines/${selected.id}/jobs`)),
      triggerJobs(all, selected.id),
    );

    items = [
      ...jobs.data.map((job) => compactJob(job, 'job')),
      ...triggers.data.map((job) => compactJob(job, 'trigger-job')),
    ];
  }

  return {
    data: {
      iid: opts.iid,
      headSha,
      detailedMergeStatus: current.data.detailedMergeStatus,
      state: pipelineState(selected),
      pipeline: compactPipeline(selected),
      pipelines: forHead.map(compactPipeline),
      items,
    },
    meta: {},
  };
}

export const pipelineCommands = [
  command(
    'pipeline-list',
    group,
    'List project pipelines, newest first.',
    {
      ...paging,
      ...conditional,
      ...since,
      ref: string('Branch or tag name.'),
      sha: sha('Commit SHA.'),
      status: string('Pipeline status.', { choices: PIPELINE_STATUSES }),
      source: string('Pipeline source such as push, merge_request_event, schedule or web.'),
      username: string('Username of the user who triggered the pipeline.'),
    },
    [],
    'pipeline-list --project my-group/my-project --ref main --status failed --per-page 20',
    listResult,
    '--since is GitLab updated_after. Child pipelines are listed only with --source parent_pipeline.',
    (ctx, opts) =>
      ctx.list(ctx.projectPath('/pipelines'), {
        updated_after: opts.since,
        ref: opts.ref,
        sha: opts.sha,
        status: opts.status,
        source: opts.source,
        username: opts.username,
      }),
  ),
  command(
    'pipeline-get',
    group,
    'Read one pipeline.',
    { ...pipelineId, ...conditional },
    ['pipeline-id'],
    'pipeline-get --project my-group/my-project --pipeline-id 456',
    pipelineResult,
    'A running pipeline has no final status yet; manual means it waits for a manual job.',
    (ctx, opts) => ctx.single(ctx.projectPath(`/pipelines/${opts['pipeline-id']}`)),
  ),
  command(
    'job-list',
    group,
    'List the jobs of a pipeline.',
    {
      ...pipelineId,
      ...paging,
      ...scope,
      'include-retried': flag('Include earlier attempts of retried jobs.'),
    },
    ['pipeline-id'],
    'job-list --project my-group/my-project --pipeline-id 456 --scope failed --all',
    `${listResult} Jobs carry status, stage, allowFailure and failureReason.`,
    'A failed job with allowFailure=true does not fail the pipeline. Downstream pipelines are reached through trigger-job-list.',
    (ctx, opts) =>
      ctx.list(ctx.projectPath(`/pipelines/${opts['pipeline-id']}/jobs`), {
        scope: opts.scope,
        include_retried: opts['include-retried'],
      }),
  ),
  command(
    'trigger-job-list',
    group,
    'List the trigger jobs of a pipeline and their downstream pipelines.',
    { ...pipelineId, ...paging, ...scope },
    ['pipeline-id'],
    'trigger-job-list --project my-group/my-project --pipeline-id 456',
    `${listResult} Each entry has downstreamPipeline {id, status, webUrl, ...}.`,
    'Read a downstream pipeline with pipeline-get and its jobs with job-list; a multi-project downstream pipeline needs --project of that project.',
    (ctx, opts) => triggerJobs(ctx, opts['pipeline-id'], { scope: opts.scope }),
  ),
  command(
    'job-get',
    group,
    'Read one CI job.',
    { ...jobId, ...conditional },
    ['job-id'],
    'job-get --project my-group/my-project --job-id 789',
    jobResult,
    'Logs are read separately with job-log.',
    (ctx, opts) => ctx.single(ctx.projectPath(`/jobs/${opts['job-id']}`)),
  ),
  command(
    'job-log',
    group,
    'Read a bounded part of a job log inside JSON; the end by default.',
    {
      ...jobId,
      from: string('Read the start or the end of the log.', {
        choices: ['tail', 'head'],
        default: 'tail',
      }),
      'max-bytes': integer('Maximum log bytes to download.', { default: '1048576', max: 10485760 }),
      'max-lines': integer('Maximum returned lines.', { default: '200', max: 10000 }),
      raw: flag('Keep terminal colors and GitLab section markers.'),
    },
    ['job-id'],
    'job-log --project my-group/my-project --job-id 789 --max-lines 200',
    'data: {jobId, from, text, truncated, returnedLines}.',
    'truncated=true means part of the log is not returned. Colors and section markers are removed unless --raw; runner timestamps stay. A running job returns its log so far; erased or expired logs return NOT_FOUND.',
    jobLog,
  ),
  command(
    'pipeline-test-report',
    group,
    'Read the unit test report of a pipeline.',
    { ...pipelineId, 'failed-only': flag('Keep only failed and errored test cases.') },
    ['pipeline-id'],
    'pipeline-test-report --project my-group/my-project --pipeline-id 456 --failed-only',
    'data: {totalCount, successCount, failedCount, skippedCount, errorCount, testSuites[{name, testCases[{status, name, classname, systemOutput, stackTrace}]}]}.',
    'Needs JUnit report artifacts in the CI configuration; otherwise all counts are 0. Suite totals keep their original values with --failed-only.',
    async (ctx, opts) => {
      const result = await ctx.single(
        ctx.projectPath(`/pipelines/${opts['pipeline-id']}/test_report`),
      );

      if (opts['failed-only'] && Array.isArray(result.data.testSuites)) {
        result.data.testSuites = result.data.testSuites
          .map((suite) => ({
            ...suite,
            testCases: (suite.testCases ?? []).filter((testCase) =>
              ['failed', 'error'].includes(testCase.status),
            ),
          }))
          .filter((suite) => suite.testCases.length || suite.suiteError);
      }

      return result;
    },
  ),
  command(
    'commit-status-list',
    group,
    'List CI job and external statuses of a commit.',
    {
      sha: sha('Commit SHA.'),
      ...paging,
      ref: string('Branch or tag of the statuses.'),
      stage: string('Stage name.'),
      name: string('Job or status name.'),
      'pipeline-id': integer('Pipeline ID.'),
      'include-history': flag('Include superseded statuses, not only the latest per name.'),
    },
    ['sha'],
    'commit-status-list --project my-group/my-project --sha 0123abcd --all',
    `${listResult} Entries have id, name, status, stage, pipelineId, allowFailure and targetUrl.`,
    'GitLab jobs appear as statuses too. External statuses belong to their own pipeline for the same commit.',
    (ctx, opts) =>
      ctx.list(ctx.projectPath(`/repository/commits/${opts.sha}/statuses`), {
        ref: opts.ref,
        stage: opts.stage,
        name: opts.name,
        pipeline_id: opts['pipeline-id'],
        all: opts['include-history'],
      }),
  ),
  command(
    'mr-pipeline-list',
    group,
    'List the pipelines of a merge request, newest first.',
    { ...mrIid, ...paging },
    ['iid'],
    'mr-pipeline-list --project my-group/my-project --iid 12',
    `${listResult} Entries have id, iid, sha, ref, status and source.`,
    'Includes branch and merge request pipelines; compare sha with the merge request head.',
    (ctx, opts) => ctx.list(mrPath(ctx, opts.iid, '/pipelines')),
  ),
  command(
    'mr-checks',
    group,
    'Read the CI state of the merge request head: its pipeline, jobs and trigger jobs.',
    mrIid,
    ['iid'],
    'mr-checks --project my-group/my-project --iid 12',
    'data: {iid, headSha, detailedMergeStatus, state, pipeline, pipelines, items}; state is no-checks|pending|running|manual|successful|failed|canceled|skipped|unknown.',
    'Uses the head pipeline of the current head SHA and reads every job page. A failed pipeline is data and exits 0. no-checks right after a push can mean the pipeline is not created yet. CI success is not approval or merge readiness.',
    mrChecks,
  ),
  command(
    'job-retry',
    group,
    'Retry a finished CI job; GitLab creates a new job.',
    jobId,
    ['job-id'],
    'job-retry --project my-group/my-project --job-id 789',
    `${jobResult} The result is the new job with a new id.`,
    'Use only when assigned, for example for a failure classified as flaky. Never retry in a loop; a real failure needs a code change.',
    (ctx, opts) => ctx.mutate('POST', ctx.projectPath(`/jobs/${opts['job-id']}/retry`)),
  ),
  command(
    'pipeline-retry',
    group,
    'Retry the failed and canceled jobs of a pipeline.',
    pipelineId,
    ['pipeline-id'],
    'pipeline-retry --project my-group/my-project --pipeline-id 456',
    pipelineResult,
    'Use only when assigned. It reruns jobs in place; read job-list again for their new state.',
    (ctx, opts) => ctx.mutate('POST', ctx.projectPath(`/pipelines/${opts['pipeline-id']}/retry`)),
  ),
];
