import {
  body,
  command,
  conditional,
  flag,
  issueIid,
  mrIid,
  noteId,
  paging,
  quickActions,
  since,
  string,
} from '../options.js';
import { readText } from '../input.js';
import { normalize } from '../client.js';
import { issuePath, mrPath } from './common.js';

const result =
  'data: note object/array with numeric id, body, author, system, internal, resolvable, createdAt and updatedAt.';

export const systemFilter = {
  system: string('System notes (activity such as label changes); filtered locally.', {
    choices: ['include', 'exclude', 'only'],
    default: 'include',
  }),
};

export function systemMatches(option, isSystem) {
  return option === 'include' || (option === 'only') === isSystem;
}

export const noteCommands = ['issue', 'mr'].flatMap((kind) => {
  const group = kind === 'issue' ? 'Issue Notes' : 'MR Notes';
  const iid = kind === 'issue' ? issueIid : mrIid;
  const path = (ctx, opts, suffix) =>
    (kind === 'issue' ? issuePath : mrPath)(ctx, opts.iid, `/notes${suffix}`);
  const noun = kind === 'issue' ? 'issue' : 'merge request';

  return [
    command(
      `${kind}-note-list`,
      group,
      `Read the comments and system notes of an ${noun}.`,
      {
        ...iid,
        ...paging,
        ...conditional,
        ...since,
        ...systemFilter,
        sort: string('Sort field.', { choices: ['created', 'updated'], default: 'created' }),
        direction: string('Sort direction; asc reads the conversation in order.', {
          choices: ['asc', 'desc'],
          default: 'asc',
        }),
      },
      ['iid'],
      `${kind}-note-list --project my-group/my-project --iid 12 --system exclude --all`,
      result,
      `--since (updatedAt after the timestamp) and --system are applied locally after paging. Thread replies appear as separate notes; ${kind}-discussion-list shows the threads.`,
      (ctx, opts) =>
        ctx.list(
          path(ctx, opts, ''),
          { order_by: `${opts.sort}_at`, sort: opts.direction },
          (entry) =>
            systemMatches(opts.system, entry.system === true) &&
            (!opts.since || Date.parse(entry.updated_at) > Date.parse(opts.since)),
        ),
    ),
    command(
      `${kind}-note-get`,
      group,
      `Read one note of an ${noun}.`,
      { ...iid, ...noteId },
      ['iid', 'note-id'],
      `${kind}-note-get --project my-group/my-project --iid 12 --note-id 345`,
      result,
      `GitLab looks the note up within the selected ${noun}; a note of another parent returns NOT_FOUND.`,
      (ctx, opts) => ctx.single(path(ctx, opts, `/${opts['note-id']}`)),
    ),
    command(
      `${kind}-note-create`,
      group,
      `Add a top-level comment to an ${noun}.`,
      {
        ...iid,
        ...body,
        internal: flag('Create an internal note visible only to project members.'),
        ...quickActions,
      },
      ['iid'],
      `${kind}-note-create --project my-group/my-project --iid 12 --body "Additional context"`,
      `${result} meta.quickActionsOnly=true when GitLab only ran quick actions and created no note.`,
      'Requires a non-empty body. Check for an equivalent comment before retrying an uncertain create. Quick action lines are refused unless --allow-quick-actions.',
      async (ctx, opts) => {
        const text = await readText(opts, 'body', { required: true, stdin: ctx.stdin });
        const response = await ctx.request('POST', path(ctx, opts, ''), {
          body: { body: text, internal: opts.internal },
        });

        return {
          data: normalize(response.body),
          meta: response.status === 202 ? { quickActionsOnly: true } : {},
        };
      },
    ),
    command(
      `${kind}-note-update`,
      group,
      `Edit a note of an ${noun}.`,
      { ...iid, ...noteId, ...body, ...quickActions },
      ['iid', 'note-id'],
      `${kind}-note-update --project my-group/my-project --iid 12 --note-id 345 --body "Corrected context"`,
      result,
      'Requires a non-empty body and ownership of the note or sufficient permission. System notes cannot be edited.',
      async (ctx, opts) => {
        const text = await readText(opts, 'body', { required: true, stdin: ctx.stdin });

        return ctx.mutate('PUT', path(ctx, opts, `/${opts['note-id']}`), { body: text });
      },
    ),
  ];
});
