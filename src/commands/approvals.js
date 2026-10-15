import { command, mrIid, sha } from '../options.js';
import { CliError } from '../errors.js';
import { concurrently } from '../client.js';
import { getMergeRequest, mrPath } from './common.js';

const group = 'MR Approvals';
const result =
  'data: approval state with approved, approvedBy[{user, approvedAt}], userHasApproved, userCanApprove and, on GitLab EE, approvalsRequired/approvalsLeft.';

function headChanged(sha, details) {
  return new CliError(
    'HEAD_CHANGED',
    'The merge request head no longer matches the reviewed SHA; reread it and review the new commits.',
    8,
    { sha, ...details },
  );
}

export function readApprovals(ctx, iid) {
  return ctx.single(mrPath(ctx, iid, '/approvals'));
}

// Approves the observed head unless --sha is given, so a push after the review is not
// approved by accident. GitLab answers 409 when the head moved. userCanApprove is not used
// as a gate: GitLab.com can report false for an approval that its approve endpoint accepts.
export async function approve(ctx, iid, expectedSha) {
  const [approvals, current] = await concurrently(
    readApprovals(ctx, iid),
    expectedSha ? undefined : getMergeRequest(ctx, iid),
  );
  const headSha = expectedSha ?? current.data.sha;

  if (approvals.data.userHasApproved) {
    // An earlier approval can survive pushes; it does not cover a reviewed SHA that is no
    // longer the head.
    const observed = expectedSha && (await getMergeRequest(ctx, iid)).data.sha;

    if (observed && !observed.startsWith(expectedSha.toLowerCase())) {
      throw headChanged(expectedSha, { headSha: observed, alreadyApproved: true });
    }

    return { data: approvals.data, meta: { ...approvals.meta, unchanged: true } };
  }
  try {
    const approved = await ctx.mutate('POST', mrPath(ctx, iid, '/approve'), { sha: headSha });

    return { data: approved.data, meta: { ...approved.meta, approvedSha: headSha } };
  } catch (error) {
    if (error.status === 409) {
      throw headChanged(headSha, { status: 409 });
    }
    if (error.status === 401) {
      // The approvals read just succeeded, so a 401 here is a refused approval, not a bad token.
      throw new CliError(
        'PERMISSION_DENIED',
        'GitLab refused the approval: the user is not an eligible approver or project rules forbid it.',
        4,
        { status: 401 },
      );
    }

    throw error;
  }
}

export const approvalCommands = [
  command(
    'mr-approval-get',
    group,
    'Read who approved a merge request and whether its approval requirements are met.',
    mrIid,
    ['iid'],
    'mr-approval-get --project my-group/my-project --iid 12',
    result,
    'approved means the approval rules are satisfied (on GitLab CE: at least one approval). It says nothing about CI, threads or mergeability.',
    (ctx, opts) => readApprovals(ctx, opts.iid),
  ),
  command(
    'mr-approve',
    group,
    'Approve a merge request as the token owner, bound to the reviewed head SHA.',
    { ...mrIid, sha: sha('Reviewed head SHA; defaults to the currently observed head.') },
    ['iid'],
    'mr-approve --project my-group/my-project --iid 12 --sha 0123abcd0123abcd0123abcd0123abcd0123abcd',
    `${result} meta.approvedSha is the approved head; meta.unchanged=true when already approved.`,
    'Use only when assigned to approve. HEAD_CHANGED means new commits arrived after the review. GitLab decides eligibility when approving; userCanApprove from mr-approval-get is advisory.',
    (ctx, opts) => approve(ctx, opts.iid, opts.sha),
  ),
  command(
    'mr-unapprove',
    group,
    'Withdraw the token owner approval.',
    mrIid,
    ['iid'],
    'mr-unapprove --project my-group/my-project --iid 12',
    `${result} meta.unchanged=true when this user had not approved.`,
    'Removes only the approval of the token owner.',
    async (ctx, opts) => {
      const approvals = await readApprovals(ctx, opts.iid);

      if (!approvals.data.userHasApproved) {
        return { ...approvals, meta: { ...approvals.meta, unchanged: true } };
      }

      return ctx.mutate('POST', mrPath(ctx, opts.iid, '/unapprove'));
    },
  ),
];
