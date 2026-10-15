import {
  body,
  command,
  conditional,
  diffLocation,
  discussionId,
  issueIid,
  mrIid,
  paging,
  quickActions,
  string,
} from '../options.js';
import { readText } from '../input.js';
import { usage } from '../errors.js';
import { issuePath, mrPath, positionFor, withThreadState } from './common.js';
import { systemFilter, systemMatches } from './notes.js';

const threadResult =
  'data: discussion object/array with id, individualNote, notes[] and derived resolvable/resolved; diff notes carry position.';
const noteResult = 'data: the created note with id, body, author, createdAt and resolvable.';

function isSystem(entry) {
  return entry.notes?.[0]?.system === true;
}

function discussionPath(kind, ctx, opts, suffix = '') {
  const base = kind === 'issue' ? issuePath : mrPath;

  return base(
    ctx,
    opts.iid,
    `/discussions${opts['discussion-id'] ? `/${opts['discussion-id']}` : ''}${suffix}`,
  );
}

async function getDiscussion(kind, ctx, opts) {
  const result = await ctx.single(discussionPath(kind, ctx, opts));

  return { ...result, data: result.data && withThreadState(result.data) };
}

async function setResolved(ctx, opts, resolved) {
  const current = await getDiscussion('mr', ctx, opts);

  if (!current.data.resolvable) {
    throw usage('This discussion has no resolvable notes; individual comments cannot be resolved.');
  }
  if (current.data.resolved === resolved) {
    return { ...current, meta: { ...current.meta, unchanged: true } };
  }

  const changed = await ctx.mutate('PUT', discussionPath('mr', ctx, opts), { resolved });

  return { ...changed, data: withThreadState(changed.data) };
}

function readReply(kind) {
  return async (ctx, opts) => {
    const text = await readText(opts, 'body', { required: true, stdin: ctx.stdin });

    return ctx.mutate('POST', discussionPath(kind, ctx, opts, '/notes'), { body: text });
  };
}

export const discussionCommands = [
  command(
    'issue-discussion-list',
    'Issue Discussions',
    'Read issue comments grouped into threads.',
    { ...issueIid, ...paging, ...systemFilter },
    ['iid'],
    'issue-discussion-list --project my-group/my-project --iid 12 --system exclude --all',
    threadResult,
    'Each thread contains all of its notes. --system is applied locally to whole threads. Issue threads are not resolvable.',
    (ctx, opts) =>
      ctx.list(discussionPath('issue', ctx, opts), {}, (entry) =>
        systemMatches(opts.system, isSystem(entry)),
      ),
  ),
  command(
    'issue-discussion-get',
    'Issue Discussions',
    'Read one issue thread with all of its notes.',
    { ...issueIid, ...discussionId },
    ['iid', 'discussion-id'],
    'issue-discussion-get --project my-group/my-project --iid 12 --discussion-id 0123456789abcdef0123456789abcdef01234567',
    threadResult,
    'A discussion of another issue returns NOT_FOUND.',
    (ctx, opts) => getDiscussion('issue', ctx, opts),
  ),
  command(
    'issue-discussion-reply',
    'Issue Discussions',
    'Reply in an issue thread; replying to a single comment turns it into a thread.',
    { ...issueIid, ...discussionId, ...body, ...quickActions },
    ['iid', 'discussion-id'],
    'issue-discussion-reply --project my-group/my-project --iid 12 --discussion-id 0123456789abcdef0123456789abcdef01234567 --body "Answered in the description"',
    noteResult,
    'Requires a non-empty body. System notes cannot be replied to.',
    readReply('issue'),
  ),
  command(
    'mr-discussion-list',
    'MR Discussions',
    'Read merge request threads, including diff threads and their resolution state.',
    {
      ...mrIid,
      ...paging,
      ...conditional,
      state: string(
        'Thread filter, applied locally; resolved/unresolved keep resolvable threads.',
        {
          choices: ['all', 'unresolved', 'resolved'],
          default: 'all',
        },
      ),
      ...systemFilter,
    },
    ['iid'],
    'mr-discussion-list --project my-group/my-project --iid 12 --state unresolved --all',
    threadResult,
    'Filters run locally after paging, so a filtered page can be empty while more pages remain. Each thread contains all notes. Resolution changes have no timestamp filter; compare snapshots.',
    async (ctx, opts) => {
      const result = await ctx.list(discussionPath('mr', ctx, opts), {}, (entry) =>
        systemMatches(opts.system, isSystem(entry)),
      );

      if (result.data) {
        result.data = result.data
          .map(withThreadState)
          .filter(
            (entry) =>
              opts.state === 'all' ||
              (entry.resolvable && entry.resolved === (opts.state === 'resolved')),
          );
        result.meta.pagination.returnedCount = result.data.length;
      }

      return result;
    },
  ),
  command(
    'mr-discussion-get',
    'MR Discussions',
    'Read one merge request thread with all of its notes.',
    { ...mrIid, ...discussionId },
    ['iid', 'discussion-id'],
    'mr-discussion-get --project my-group/my-project --iid 12 --discussion-id 0123456789abcdef0123456789abcdef01234567',
    threadResult,
    'A discussion of another merge request returns NOT_FOUND.',
    (ctx, opts) => getDiscussion('mr', ctx, opts),
  ),
  command(
    'mr-discussion-create',
    'MR Discussions',
    'Start a resolvable thread, on the overview or on a diff line.',
    { ...mrIid, ...body, ...diffLocation, ...quickActions },
    ['iid'],
    'mr-discussion-create --project my-group/my-project --iid 12 --path src/app.js --new-line 42 --body "Handle the empty input"',
    threadResult,
    'Without --path the thread is general. With --path supply --new-line (added or unchanged line) or --old-line (removed line); the CLI computes GitLab position SHAs and line codes from the latest diff version or --head-sha. The line must be in the diff or an unchanged line of a changed file.',
    async (ctx, opts) => {
      const text = await readText(opts, 'body', { required: true, stdin: ctx.stdin });
      const position = await positionFor(ctx, opts);
      const created = await ctx.mutate('POST', discussionPath('mr', ctx, opts), {
        body: text,
        position,
      });

      return { ...created, data: withThreadState(created.data) };
    },
  ),
  command(
    'mr-discussion-reply',
    'MR Discussions',
    'Reply in a merge request thread.',
    { ...mrIid, ...discussionId, ...body, ...quickActions },
    ['iid', 'discussion-id'],
    'mr-discussion-reply --project my-group/my-project --iid 12 --discussion-id 0123456789abcdef0123456789abcdef01234567 --body "Fixed in the latest commit"',
    noteResult,
    'Requires a non-empty body. Replying does not resolve the thread; use mr-discussion-resolve when assigned.',
    readReply('mr'),
  ),
  command(
    'mr-discussion-resolve',
    'MR Discussions',
    'Mark a merge request thread resolved.',
    { ...mrIid, ...discussionId },
    ['iid', 'discussion-id'],
    'mr-discussion-resolve --project my-group/my-project --iid 12 --discussion-id 0123456789abcdef0123456789abcdef01234567',
    `${threadResult} meta.unchanged=true when it was already resolved.`,
    'Reads the thread first and refuses threads without resolvable notes. Resolving feedback is not an approval.',
    (ctx, opts) => setResolved(ctx, opts, true),
  ),
  command(
    'mr-discussion-unresolve',
    'MR Discussions',
    'Reopen a resolved merge request thread.',
    { ...mrIid, ...discussionId },
    ['iid', 'discussion-id'],
    'mr-discussion-unresolve --project my-group/my-project --iid 12 --discussion-id 0123456789abcdef0123456789abcdef01234567',
    `${threadResult} meta.unchanged=true when it was already unresolved.`,
    'Reads the thread first and refuses threads without resolvable notes.',
    (ctx, opts) => setResolved(ctx, opts, false),
  ),
];
