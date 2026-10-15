import {
  command,
  conditional,
  description,
  direction,
  flag,
  issueIid,
  paging,
  quickActions,
  since,
  string,
} from '../options.js';
import { readText, requireChanges } from '../input.js';
import { usage } from '../errors.js';
import {
  assigneeEdits,
  issuePath,
  labelEdits,
  labels,
  metadataFields,
  milestoneEdits,
  sortField,
  userFilter,
  userIds,
} from './common.js';

const group = 'Issues';
const objectResult =
  'data: issue with id, iid, title, description, state, labels, assignees, milestone, author, createdAt, updatedAt and webUrl.';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const title = { title: string('Issue title, at most 255 characters.') };
const dueDate = {
  'due-date': string('Due date as YYYY-MM-DD.', { pattern: DATE, hint: 'must be YYYY-MM-DD' }),
};
const confidential = {
  confidential: string('Confidential issue visible only to members with access.', {
    choices: ['true', 'false'],
  }),
};

function booleanChoice(value) {
  return value === undefined ? undefined : value === 'true';
}

function checkTitle(value) {
  if (value !== undefined && value.length > 255) {
    throw usage('--title must be at most 255 characters.');
  }
}

async function setState(ctx, opts, state) {
  const current = await ctx.single(issuePath(ctx, opts.iid));

  if (current.data.state === state) {
    return { ...current, meta: { ...current.meta, unchanged: true } };
  }

  return ctx.mutate('PUT', issuePath(ctx, opts.iid), {
    state_event: state === 'closed' ? 'close' : 'reopen',
  });
}

export const issueCommands = [
  command(
    'issue-list',
    group,
    'List project issues with native GitLab filters.',
    {
      ...paging,
      ...conditional,
      ...since,
      state: string('Issue state.', { choices: ['opened', 'closed', 'all'], default: 'opened' }),
      label: string('Label name; repeat to require all. None or Any match no or any label.', {
        multiple: true,
      }),
      milestone: string('Milestone title, None or Any.'),
      author: string('Author username.'),
      assignee: string('Assignee username, None or Any.'),
      search: string('Search text in titles and descriptions.'),
      sort: string('Sort field.', {
        choices: ['created', 'updated', 'priority', 'due_date', 'popularity'],
        default: 'created',
      }),
      ...direction,
    },
    [],
    'issue-list --project my-group/my-project --state all --sort updated --since 2026-01-01T00:00:00Z --all',
    'data: issue array; meta.pagination contains continuation and totals.',
    '--since is GitLab updated_after, inclusive. Labels are ANDed. Search uses GitLab search and can be rate limited.',
    (ctx, opts) =>
      ctx.list(ctx.projectPath('/issues'), {
        state: opts.state === 'all' ? undefined : opts.state,
        updated_after: opts.since,
        labels: labels(opts.label),
        milestone: opts.milestone,
        author_username: opts.author,
        ...userFilter(opts.assignee, 'assignee_id', 'assignee_username'),
        search: opts.search,
        order_by: sortField(opts.sort),
        sort: opts.direction,
      }),
  ),
  command(
    'issue-get',
    group,
    'Read one issue.',
    { ...issueIid, ...conditional },
    ['iid'],
    'issue-get --project my-group/my-project --iid 12',
    objectResult,
    'Does not read comments; use issue-note-list or issue-discussion-list.',
    (ctx, opts) => ctx.single(issuePath(ctx, opts.iid)),
  ),
  command(
    'issue-create',
    group,
    'Create an issue.',
    {
      ...title,
      ...description,
      label: labelEdits.label,
      assignee: assigneeEdits.assignee,
      milestone: milestoneEdits.milestone,
      ...dueDate,
      ...confidential,
      ...quickActions,
    },
    ['title'],
    'issue-create --project my-group/my-project --title "Fix startup" --description "Steps to reproduce" --label bug',
    objectResult,
    'Search existing issues first; a retry after an uncertain result can duplicate the issue. Unknown labels are created. GitLab Free keeps one assignee.',
    async (ctx, opts) => {
      checkTitle(opts.title);

      const text = await readText(opts, 'description', { stdin: ctx.stdin });

      return ctx.mutate('POST', ctx.projectPath('/issues'), {
        title: opts.title,
        description: text,
        labels: labels(opts.label),
        assignee_ids: await userIds(ctx, opts.assignee),
        milestone: opts.milestone,
        due_date: opts['due-date'],
        confidential: booleanChoice(opts.confidential),
      });
    },
  ),
  command(
    'issue-update',
    group,
    'Update explicitly supplied issue fields.',
    {
      ...issueIid,
      ...title,
      ...description,
      ...labelEdits,
      ...assigneeEdits,
      ...milestoneEdits,
      ...dueDate,
      'clear-due-date': flag('Remove the due date.', { conflicts: ['due-date'] }),
      ...confidential,
      ...quickActions,
    },
    ['iid'],
    'issue-update --project my-group/my-project --iid 12 --add-label bug --assignee alex',
    objectResult,
    '--label and --assignee replace the whole collection; --add-label/--remove-label change labels incrementally. Read the issue first. Use issue-close/issue-reopen for state.',
    async (ctx, opts) => {
      checkTitle(opts.title);

      const text = await readText(opts, 'description', { stdin: ctx.stdin });
      const fields = {
        title: opts.title,
        description: text,
        ...(await metadataFields(ctx, opts)),
        due_date: opts['clear-due-date'] ? '' : opts['due-date'],
        confidential: booleanChoice(opts.confidential),
      };

      requireChanges(fields);

      return ctx.mutate('PUT', issuePath(ctx, opts.iid), fields);
    },
  ),
  command(
    'issue-close',
    group,
    'Close an issue.',
    issueIid,
    ['iid'],
    'issue-close --project my-group/my-project --iid 12',
    `${objectResult} meta.unchanged=true when it was already closed.`,
    'Use only when explicitly assigned to close the issue. Merging a merge request with a closing pattern closes issues as well.',
    (ctx, opts) => setState(ctx, opts, 'closed'),
  ),
  command(
    'issue-reopen',
    group,
    'Reopen a closed issue.',
    issueIid,
    ['iid'],
    'issue-reopen --project my-group/my-project --iid 12',
    `${objectResult} meta.unchanged=true when it was already open.`,
    'Requires permission to update the issue.',
    (ctx, opts) => setState(ctx, opts, 'opened'),
  ),
];
