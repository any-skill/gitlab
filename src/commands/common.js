import { CliError, usage } from '../errors.js';
import { concurrently } from '../client.js';
import { diffPosition } from '../diff.js';
import { flag, string } from '../options.js';

// Label names travel as one comma-separated API value, so a name cannot contain a comma.
export function labels(names) {
  if (names === undefined) {
    return undefined;
  }
  if (names.some((name) => name.includes(','))) {
    throw usage('Label names must not contain commas.');
  }

  return names.map((name) => name.trim()).join(',');
}

export const labelEdits = {
  label: string('Label name; repeat to replace all labels with these.', { multiple: true }),
  'add-label': string('Label name to add; repeatable.', { multiple: true }),
  'remove-label': string('Label name to remove; repeatable.', { multiple: true }),
  'clear-labels': flag('Remove every label.', {
    conflicts: ['label', 'add-label', 'remove-label'],
  }),
};
export const assigneeEdits = {
  assignee: string('Assignee username; repeat to replace all assignees with these.', {
    multiple: true,
  }),
  'clear-assignees': flag('Remove every assignee.', { conflicts: ['assignee'] }),
};
export const reviewerEdits = {
  reviewer: string('Reviewer username; repeat to replace all reviewers with these.', {
    multiple: true,
  }),
  'clear-reviewers': flag('Remove every reviewer.', { conflicts: ['reviewer'] }),
};
export const milestoneEdits = {
  milestone: string('Exact milestone title of the project or an ancestor group.'),
  'clear-milestone': flag('Remove the milestone.', { conflicts: ['milestone'] }),
};

// GitLab assigns users by numeric ID; usernames are resolved with exact matches.
export async function userIds(ctx, usernames) {
  if (usernames === undefined) {
    return undefined;
  }

  const names = usernames.map((name) => name.trim().replace(/^@/, ''));
  const responses = await concurrently(
    ...names.map((username) => ctx.request('GET', 'users', { query: { username } })),
  );

  return responses.map((response, index) => {
    if (!Array.isArray(response.body)) {
      throw new CliError('INVALID_RESPONSE', 'Expected a user array.');
    }

    const user = response.body.find(
      (entry) => entry?.username?.toLowerCase() === names[index].toLowerCase(),
    );

    if (!user) {
      throw usage(`Unknown GitLab username: ${names[index]}.`);
    }

    return user.id;
  });
}

// Maps the shared label/assignee/reviewer/milestone options to GitLab update fields.
export async function metadataFields(ctx, opts) {
  const [assignees, reviewers] = await concurrently(
    userIds(ctx, opts.assignee),
    userIds(ctx, opts.reviewer),
  );

  return {
    labels: opts['clear-labels'] ? '' : labels(opts.label),
    add_labels: labels(opts['add-label']),
    remove_labels: labels(opts['remove-label']),
    assignee_ids: opts['clear-assignees'] ? [] : assignees,
    reviewer_ids: opts['clear-reviewers'] ? [] : reviewers,
    milestone: opts.milestone,
    milestone_id: opts['clear-milestone'] ? 0 : undefined,
  };
}

// None and Any are GitLab's filter values for "no user" and "any user"; other values are
// usernames.
export function userFilter(value, idKey, usernameKey) {
  if (value === undefined) {
    return {};
  }

  return ['None', 'Any'].includes(value) ? { [idKey]: value } : { [usernameKey]: value };
}

export function sortField(value) {
  return { created: 'created_at', updated: 'updated_at', merged: 'merged_at' }[value] ?? value;
}

export function issuePath(ctx, iid, suffix = '') {
  return ctx.projectPath(`/issues/${iid}${suffix}`);
}

export function mrPath(ctx, iid, suffix = '') {
  return ctx.projectPath(`/merge_requests/${iid}${suffix}`);
}

export function getMergeRequest(ctx, iid) {
  return ctx.single(mrPath(ctx, iid));
}

// Selects the newest merge request diff version, or the one whose head is the reviewed SHA,
// and reads its file diffs for position calculation.
export async function diffVersion(ctx, iid, headSha) {
  const response = await ctx.request('GET', mrPath(ctx, iid, '/versions'), {
    query: { per_page: 100 },
  });

  if (!Array.isArray(response.body)) {
    throw new CliError('INVALID_RESPONSE', 'Expected an array of diff versions.');
  }

  const version = headSha
    ? response.body.find((entry) => entry.head_commit_sha?.startsWith(headSha.toLowerCase()))
    : response.body[0];

  if (!version) {
    throw new CliError(
      headSha ? 'HEAD_NOT_FOUND' : 'DIFF_NOT_READY',
      headSha
        ? `No diff version of !${iid} has head ${headSha}; reread the merge request.`
        : `Merge request !${iid} has no diff version yet; retry after GitLab prepares it.`,
      8,
    );
  }

  return (await ctx.request('GET', mrPath(ctx, iid, `/versions/${version.id}`))).body;
}

// Diff location options shared by discussions and draft notes. Returns undefined when the
// note is not attached to the diff.
export async function positionFor(ctx, opts, version) {
  const line = opts['new-line'] ?? opts['old-line'];

  if (!opts.path) {
    if (line !== undefined || opts['start-line'] !== undefined || opts['head-sha']) {
      throw usage('--new-line, --old-line, --start-line and --head-sha require --path.');
    }

    return undefined;
  }
  if (line === undefined) {
    throw usage('--path requires --new-line or --old-line.');
  }

  return diffPosition(version ?? (await diffVersion(ctx, opts.iid, opts['head-sha'])), {
    path: opts.path,
    side: opts['new-line'] === undefined ? 'old' : 'new',
    line,
    startLine: opts['start-line'],
  });
}

// Derived thread state: resolvable when any note can be resolved, resolved when all are.
export function withThreadState(discussion) {
  const notes = (discussion.notes ?? []).filter((note) => note.resolvable);

  return {
    ...discussion,
    resolvable: notes.length > 0,
    resolved: notes.length > 0 && notes.every((note) => note.resolved),
  };
}
