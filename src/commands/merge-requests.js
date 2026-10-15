import {
  command,
  conditional,
  description,
  direction,
  flag,
  integer,
  mrIid,
  paging,
  quickActions,
  since,
  string,
} from '../options.js';
import { readText, requireChanges } from '../input.js';
import { CliError, usage } from '../errors.js';
import { concurrently } from '../client.js';
import { parseProject } from '../project.js';
import { readHead } from '../log.js';
import {
  assigneeEdits,
  getMergeRequest,
  labelEdits,
  labels,
  metadataFields,
  milestoneEdits,
  mrPath,
  reviewerEdits,
  sortField,
  userFilter,
  userIds,
} from './common.js';

const group = 'Merge Requests';
const objectResult =
  'data: merge request with id, iid, title, state, draft, sourceBranch, targetBranch, sha, detailedMergeStatus, headPipeline, diffRefs, reviewers and webUrl.';
const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s*-)/i;
const setDraftMutation = `mutation($projectPath: ID!, $iid: String!, $draft: Boolean!) {
  mergeRequestSetDraft(input: {projectPath: $projectPath, iid: $iid, draft: $draft}) { errors }
}`;

const mergeOptions = {
  'remove-source-branch': string('Delete the source branch after merge.', {
    choices: ['true', 'false'],
  }),
  squash: string('Squash commits on merge.', { choices: ['true', 'false'] }),
};

function checkTitle(value) {
  if (value !== undefined && value.length > 255) {
    throw usage('--title must be at most 255 characters.');
  }
}

function booleanChoice(value) {
  return value === undefined ? undefined : value === 'true';
}

// Draft state is changed with GitLab's own mutation, which handles every draft title prefix.
async function setDraft(ctx, opts, draft) {
  const current = await getMergeRequest(ctx, opts.iid);

  if (current.data.draft === draft) {
    return { ...current, meta: { ...current.meta, unchanged: true } };
  }

  const projectPath = current.data.references?.full?.replace(/!\d+$/, '');

  if (!projectPath) {
    throw new CliError('INVALID_RESPONSE', 'GitLab did not return the merge request reference.');
  }

  const data = await ctx.graphql(setDraftMutation, {
    projectPath,
    iid: String(opts.iid),
    draft,
  });
  const errors = data.mergeRequestSetDraft?.errors;

  if (!Array.isArray(errors)) {
    throw new CliError('INVALID_RESPONSE', 'GitLab did not confirm the draft change.');
  }
  if (errors.length) {
    throw new CliError('API_ERROR', errors.join('; '), 8);
  }

  return getMergeRequest(ctx, opts.iid);
}

// Looks for an open merge request from the same source project and branch.
async function preflight(ctx, opts) {
  let listPath = ctx.projectPath('/merge_requests');
  let targetId;
  let sameSource = (entry) => entry.source_project_id === entry.target_project_id;

  if (opts['target-project']) {
    const targetProject = parseProject(opts['target-project'], ctx.host);
    const [source, target] = await concurrently(
      ctx.single(ctx.projectPath()),
      ctx.single(`projects/${encodeURIComponent(targetProject.id)}`),
    );

    targetId = target.data.id;
    listPath = `projects/${targetId}/merge_requests`;
    sameSource = (entry) => entry.source_project_id === source.data.id;
  }

  const existing = await ctx.request('GET', listPath, {
    query: { source_branch: opts['source-branch'], state: 'opened', per_page: 100 },
  });

  if (!Array.isArray(existing.body)) {
    throw new CliError('INVALID_RESPONSE', 'Expected an array of merge requests.');
  }

  const duplicate = existing.body.find(sameSource);

  if (duplicate) {
    throw new CliError(
      'ALREADY_EXISTS',
      'An open merge request already exists for this source branch.',
      8,
      { iid: duplicate.iid, webUrl: duplicate.web_url },
    );
  }

  return targetId;
}

export const mergeRequestCommands = [
  command(
    'mr-list',
    group,
    'List project merge requests with native GitLab filters.',
    {
      ...paging,
      ...conditional,
      ...since,
      state: string('Merge request state.', {
        choices: ['opened', 'closed', 'merged', 'locked', 'all'],
        default: 'opened',
      }),
      'source-branch': string('Source branch name; use it to find the merge request of a branch.'),
      'target-branch': string('Target branch name.'),
      label: string('Label name; repeat to require all. None or Any match no or any label.', {
        multiple: true,
      }),
      milestone: string('Milestone title, None or Any.'),
      author: string('Author username.'),
      assignee: string('Assignee username, None or Any.'),
      reviewer: string('Reviewer username, None or Any.'),
      search: string('Search text in titles and descriptions.'),
      drafts: string('Draft merge requests.', {
        choices: ['include', 'exclude', 'only'],
        default: 'include',
      }),
      sort: string('Sort field.', {
        choices: ['created', 'updated', 'merged', 'title', 'priority', 'popularity'],
        default: 'created',
      }),
      ...direction,
    },
    [],
    'mr-list --project my-group/my-project --source-branch feature --state opened',
    'data: merge request array; meta.pagination contains continuation and totals.',
    '--since is GitLab updated_after, inclusive. List entries omit some single-object fields such as headPipeline and diffRefs; read mr-get for them.',
    (ctx, opts) =>
      ctx.list(ctx.projectPath('/merge_requests'), {
        state: opts.state,
        updated_after: opts.since,
        source_branch: opts['source-branch'],
        target_branch: opts['target-branch'],
        labels: labels(opts.label),
        milestone: opts.milestone,
        author_username: opts.author,
        ...userFilter(opts.assignee, 'assignee_id', 'assignee_username'),
        ...userFilter(opts.reviewer, 'reviewer_id', 'reviewer_username'),
        search: opts.search,
        draft: { exclude: false, only: true }[opts.drafts],
        order_by: sortField(opts.sort),
        sort: opts.direction,
      }),
  ),
  command(
    'mr-get',
    group,
    'Read a merge request with its head SHA, merge status, head pipeline and diff refs.',
    { ...mrIid, ...conditional },
    ['iid'],
    'mr-get --project my-group/my-project --iid 12',
    objectResult,
    'GitLab checks mergeability asynchronously: detailedMergeStatus can be checking/unchecked. Approval, CI, threads and mergeability are separate signals.',
    (ctx, opts) => getMergeRequest(ctx, opts.iid),
  ),
  command(
    'mr-create',
    group,
    'Create a merge request after checking for an open one from the same source branch.',
    {
      'source-branch': string('Branch with the changes; push it with Git first.'),
      'target-branch': string('Branch to merge into.'),
      title: string('Merge request title, at most 255 characters.'),
      ...description,
      label: labelEdits.label,
      assignee: assigneeEdits.assignee,
      reviewer: reviewerEdits.reviewer,
      milestone: milestoneEdits.milestone,
      draft: flag('Create a draft; GitLab marks drafts with a "Draft:" title prefix.'),
      ...mergeOptions,
      'target-project': string(
        'Target project path or ID for a merge request from a fork; --project is the fork.',
      ),
      ...quickActions,
    },
    ['source-branch', 'target-branch', 'title'],
    'mr-create --project my-group/my-project --source-branch feature --target-branch main --title "Fix startup" --description "Summary" --draft',
    objectResult,
    'Push the branch with Git first. An existing open merge request returns ALREADY_EXISTS with its iid. Preflight cannot exclude concurrent creation.',
    async (ctx, opts) => {
      const title =
        opts.draft && !DRAFT_PREFIX.test(opts.title) ? `Draft: ${opts.title}` : opts.title;

      checkTitle(title);

      const text = await readText(opts, 'description', { stdin: ctx.stdin });
      const targetId = await preflight(ctx, opts);
      const [assignees, reviewers] = await concurrently(
        userIds(ctx, opts.assignee),
        userIds(ctx, opts.reviewer),
      );

      try {
        return await ctx.mutate('POST', ctx.projectPath('/merge_requests'), {
          source_branch: opts['source-branch'],
          target_branch: opts['target-branch'],
          title,
          description: text,
          labels: labels(opts.label),
          assignee_ids: assignees,
          reviewer_ids: reviewers,
          milestone: opts.milestone,
          remove_source_branch: booleanChoice(opts['remove-source-branch']),
          squash: booleanChoice(opts.squash),
          target_project_id: targetId,
        });
      } catch (error) {
        if (error.status === 409) {
          const iid = Number(error.message.match(/!(\d+)/)?.[1]);

          throw new CliError('ALREADY_EXISTS', error.message, 8, {
            status: 409,
            ...(iid ? { iid } : {}),
          });
        }

        throw error;
      }
    },
  ),
  command(
    'mr-update',
    group,
    'Update explicitly supplied merge request fields.',
    {
      ...mrIid,
      title: string('New title, at most 255 characters.'),
      ...description,
      'target-branch': string('New target branch.'),
      ...labelEdits,
      ...assigneeEdits,
      ...reviewerEdits,
      ...milestoneEdits,
      ...mergeOptions,
      state: string('Close or reopen the merge request.', { choices: ['opened', 'closed'] }),
      ...quickActions,
    },
    ['iid'],
    'mr-update --project my-group/my-project --iid 12 --title "Updated summary" --add-label review',
    objectResult,
    '--label/--assignee/--reviewer replace whole collections; read the merge request first. --state closed needs an explicit assignment. This CLI never merges.',
    async (ctx, opts) => {
      checkTitle(opts.title);

      const text = await readText(opts, 'description', { stdin: ctx.stdin });
      const fields = {
        title: opts.title,
        description: text,
        target_branch: opts['target-branch'],
        ...(await metadataFields(ctx, opts)),
        remove_source_branch: booleanChoice(opts['remove-source-branch']),
        squash: booleanChoice(opts.squash),
        state_event: { opened: 'reopen', closed: 'close' }[opts.state],
      };

      requireChanges(fields);

      return ctx.mutate('PUT', mrPath(ctx, opts.iid), fields);
    },
  ),
  command(
    'mr-draft',
    group,
    'Mark a merge request as draft.',
    mrIid,
    ['iid'],
    'mr-draft --project my-group/my-project --iid 12',
    `${objectResult} meta.unchanged=true when it already was a draft.`,
    'Uses the GitLab GraphQL mutation mergeRequestSetDraft, then rereads the merge request.',
    (ctx, opts) => setDraft(ctx, opts, true),
  ),
  command(
    'mr-ready',
    group,
    'Mark a draft merge request ready for review.',
    mrIid,
    ['iid'],
    'mr-ready --project my-group/my-project --iid 12',
    `${objectResult} meta.unchanged=true when it was not a draft.`,
    'This can notify reviewers. Use only within the assigned task.',
    (ctx, opts) => setDraft(ctx, opts, false),
  ),
  command(
    'mr-commits',
    group,
    'List the commits of a merge request.',
    { ...mrIid, ...paging },
    ['iid'],
    'mr-commits --project my-group/my-project --iid 12 --all',
    'data: commit array with id (SHA), shortId, title, message, authorName and createdAt; newest first.',
    'Use standard Git for complete history and content.',
    (ctx, opts) => ctx.list(mrPath(ctx, opts.iid, '/commits')),
  ),
  command(
    'mr-diffs',
    group,
    'List the changed files of a merge request with their diffs.',
    {
      ...mrIid,
      ...paging,
      unidiff: flag('Return each diff in unified format with file headers.'),
    },
    ['iid'],
    'mr-diffs --project my-group/my-project --iid 12 --all',
    'data: file array with oldPath, newPath, newFile, renamedFile, deletedFile, generatedFile, collapsed, tooLarge and diff.',
    'Merge request diff limits apply: tooLarge or collapsed entries have no diff text. Use Git for complete source.',
    (ctx, opts) => ctx.list(mrPath(ctx, opts.iid, '/diffs'), { unidiff: opts.unidiff }),
  ),
  command(
    'mr-diff',
    group,
    'Read the unified diff of a merge request inside JSON.',
    {
      ...mrIid,
      'max-bytes': integer('Maximum returned UTF-8 bytes.', { default: '1048576', max: 10485760 }),
    },
    ['iid'],
    'mr-diff --project my-group/my-project --iid 12 --max-bytes 1048576',
    'data: {diff, truncated, returnedBytes}; diff is a string, never raw stdout.',
    'truncated=true means the returned diff is incomplete. GitLab diff limits apply; use Git for the complete diff.',
    async (ctx, opts) => {
      const response = await ctx.stream(mrPath(ctx, opts.iid, '/raw_diffs'));
      const { bytes, truncated } = await readHead(response.body, opts['max-bytes'], Infinity);
      const diff = new TextDecoder('utf-8').decode(bytes, { stream: truncated });

      return { data: { diff, truncated, returnedBytes: Buffer.byteLength(diff) }, meta: {} };
    },
  ),
  command(
    'mr-reviewer-list',
    group,
    'List reviewers and their review states.',
    { ...mrIid, ...paging },
    ['iid'],
    'mr-reviewer-list --project my-group/my-project --iid 12',
    'data: array of {user, state, createdAt}; state is unreviewed, review_started, reviewed, requested_changes, approved or unapproved.',
    'A review state is not an approval; read mr-approval-get for approvals.',
    (ctx, opts) => ctx.list(mrPath(ctx, opts.iid, '/reviewers')),
  ),
];
