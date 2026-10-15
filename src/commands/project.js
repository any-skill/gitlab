import { command, conditional, flag, paging, sha, since, string, timestamp } from '../options.js';

const group = 'Project and Repository';
const objectResult = 'data: GitLab resource object with camelCase keys.';
const listResult = 'data: resource array; meta.pagination describes remaining pages.';
const commitSha = { sha: sha('Commit SHA.') };

export const projectCommands = [
  command(
    'project-get',
    group,
    'Read project metadata, default branch, merge settings and the token permissions.',
    conditional,
    [],
    'project-get --project my-group/my-project',
    'data: project object with id, pathWithNamespace, defaultBranch, visibility, mergeMethod, permissions and webUrl.',
    'A private or inaccessible project returns NOT_FOUND. permissions.projectAccess/groupAccess.accessLevel is 10 guest to 50 owner.',
    (ctx) => ctx.single(ctx.projectPath()),
  ),
  command(
    'branch-list',
    group,
    'List repository branches.',
    { ...paging, search: string('Return branches whose names contain this text.') },
    [],
    'branch-list --project my-group/my-project --search feature --all',
    listResult,
    'protected and developersCanPush describe branch rules, not this token. Use Git to create, push or delete branches.',
    (ctx, opts) => ctx.list(ctx.projectPath('/repository/branches'), { search: opts.search }),
  ),
  command(
    'branch-get',
    group,
    'Read a branch and its latest commit.',
    { branch: string('Branch name.') },
    ['branch'],
    'branch-get --project my-group/my-project --branch main',
    objectResult,
    'Branch names, including names with slashes, are URL-encoded by the CLI.',
    (ctx, opts) =>
      ctx.single(ctx.projectPath(`/repository/branches/${encodeURIComponent(opts.branch)}`)),
  ),
  command(
    'commit-list',
    group,
    'List commits reachable from a ref.',
    {
      ...paging,
      ref: string('Branch, tag or commit SHA; defaults to the default branch.'),
      ...since,
      until: timestamp('ISO 8601 upper commit-date bound.'),
      path: string('Only commits that touch this repository-relative path.'),
      author: string('Commit author name or email.'),
      'first-parent': flag('Follow only the first parent of merge commits.'),
    },
    [],
    'commit-list --project my-group/my-project --ref main --per-page 10',
    listResult,
    '--since/--until are committed-date filters, not a change-event stream. GitLab omits totals for commit lists.',
    (ctx, opts) =>
      ctx.list(ctx.projectPath('/repository/commits'), {
        ref_name: opts.ref,
        since: opts.since,
        until: opts.until,
        path: opts.path,
        author: opts.author,
        first_parent: opts['first-parent'],
      }),
  ),
  command(
    'commit-get',
    group,
    'Read commit metadata, statistics and its latest pipeline.',
    commitSha,
    ['sha'],
    'commit-get --project my-group/my-project --sha 0123abcd',
    'data: commit with id, parentIds, message, stats {additions, deletions, total}, lastPipeline and status.',
    'Changed files are read with commit-diff.',
    (ctx, opts) => ctx.single(ctx.projectPath(`/repository/commits/${opts.sha}`), { stats: true }),
  ),
  command(
    'commit-diff',
    group,
    'List the file diffs of a commit.',
    {
      ...commitSha,
      ...paging,
      unidiff: flag('Return each diff in unified format with file headers.'),
    },
    ['sha'],
    'commit-diff --project my-group/my-project --sha 0123abcd --all',
    'data: diff array with oldPath, newPath, newFile, renamedFile, deletedFile and diff text.',
    'GitLab diff limits apply: large or binary files can have an empty or collapsed diff. Use Git for complete source.',
    (ctx, opts) =>
      ctx.list(ctx.projectPath(`/repository/commits/${opts.sha}/diff`), {
        unidiff: opts.unidiff,
      }),
  ),
  command(
    'label-list',
    group,
    'List labels of the project and its ancestor groups.',
    { ...paging, search: string('Return labels whose names contain this text.') },
    [],
    'label-list --project my-group/my-project --all',
    listResult,
    'This command reads labels. Setting an unknown label on an issue or merge request makes GitLab create it.',
    (ctx, opts) => ctx.list(ctx.projectPath('/labels'), { search: opts.search }),
  ),
  command(
    'milestone-list',
    group,
    'List project milestones.',
    {
      ...paging,
      state: string('Milestone state.', {
        choices: ['active', 'closed', 'all'],
        default: 'active',
      }),
      search: string('Return milestones whose titles contain this text.'),
    },
    [],
    'milestone-list --project my-group/my-project --state all',
    listResult,
    'Issue and merge request commands take the exact milestone title. Group milestones are not listed here.',
    (ctx, opts) =>
      ctx.list(ctx.projectPath('/milestones'), {
        state: opts.state === 'all' ? undefined : opts.state,
        search: opts.search,
      }),
  ),
  command(
    'member-list',
    group,
    'List project members, including members inherited from groups.',
    { ...paging, query: string('Filter by name or username.') },
    [],
    'member-list --project my-group/my-project --query alex',
    'data: member array with id, username, name, state and accessLevel (10 guest to 50 owner).',
    'Use usernames from this list for --assignee and --reviewer. Membership does not prove a user may approve.',
    (ctx, opts) => ctx.list(ctx.projectPath('/members/all'), { query: opts.query }),
  ),
];
