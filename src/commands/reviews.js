import {
  body,
  command,
  diffLocation,
  discussionId,
  flag,
  integer,
  mrIid,
  paging,
  quickActions,
  sha,
  string,
} from '../options.js';
import { readReviewComments, readText } from '../input.js';
import { CliError, apiError, usage } from '../errors.js';
import { concurrently } from '../client.js';
import { diffPosition } from '../diff.js';
import { approve } from './approvals.js';
import { diffVersion, getMergeRequest, mrPath, positionFor } from './common.js';

const group = 'Reviews';
const draftResult =
  'data: draft note object/array with id, note, position, discussionId, resolveDiscussion and commitId.';
const draftId = { 'draft-id': integer('Numeric draft note ID.') };
const REVIEWER_STATES = { 'requested-changes': 'requested_changes', reviewed: 'reviewed' };

function draftsPath(ctx, iid, suffix = '') {
  return mrPath(ctx, iid, `/draft_notes${suffix}`);
}

async function pendingDrafts(ctx, iid) {
  const all = ctx.withOptions({ all: true, page: 1, 'per-page': 100 });

  return (await all.list(draftsPath(ctx, iid))).data;
}

// Publishing sends every pending draft of the token owner, including older forgotten ones.
async function publish(ctx, iid, note, reviewerState) {
  await ctx.request('POST', draftsPath(ctx, iid, '/bulk_publish'), {
    body: { note, reviewer_state: reviewerState },
  });
}

function withDetails(error, details, hint) {
  const failure = apiError(error);

  failure.details = { ...failure.details, ...details };
  failure.message = `${failure.message} ${hint}`;

  return failure;
}

export const reviewCommands = [
  command(
    'review-draft-list',
    group,
    'List your pending draft notes on a merge request.',
    { ...mrIid, ...paging },
    ['iid'],
    'review-draft-list --project my-group/my-project --iid 12 --all',
    draftResult,
    'Draft notes are visible only to their author until published.',
    (ctx, opts) => ctx.list(draftsPath(ctx, opts.iid)),
  ),
  command(
    'review-draft-create',
    group,
    'Add a pending review comment: general, on a diff line, or as a reply to a thread.',
    {
      ...mrIid,
      ...body,
      ...diffLocation,
      ...discussionId,
      resolve: flag('Resolve the replied thread when the draft is published.'),
      ...quickActions,
    },
    ['iid'],
    'review-draft-create --project my-group/my-project --iid 12 --path src/app.js --new-line 42 --body "Handle the empty input"',
    draftResult,
    'Nothing is visible to others until review-publish or review-submit. --discussion-id replies to a thread and cannot be combined with --path. Positions are computed like mr-discussion-create.',
    async (ctx, opts) => {
      const text = await readText(opts, 'body', { required: true, stdin: ctx.stdin });

      if (opts['discussion-id'] && opts.path) {
        throw usage('Use --discussion-id for a reply or --path for a diff comment, not both.');
      }
      if (opts.resolve && !opts['discussion-id']) {
        throw usage('--resolve requires --discussion-id.');
      }

      return ctx.mutate('POST', draftsPath(ctx, opts.iid), {
        note: text,
        position: await positionFor(ctx, opts),
        in_reply_to_discussion_id: opts['discussion-id'],
        resolve_discussion: opts.resolve,
      });
    },
  ),
  command(
    'review-draft-delete',
    group,
    'Delete one of your pending draft notes.',
    { ...mrIid, ...draftId },
    ['iid', 'draft-id'],
    'review-draft-delete --project my-group/my-project --iid 12 --draft-id 345',
    'data: {id, deleted: true}.',
    'Deletes only an unpublished draft of the token owner; published notes are not affected.',
    async (ctx, opts) => {
      await ctx.request('DELETE', draftsPath(ctx, opts.iid, `/${opts['draft-id']}`));

      return { data: { id: opts['draft-id'], deleted: true }, meta: {} };
    },
  ),
  command(
    'review-publish',
    group,
    'Publish all of your pending draft notes as one review, with an optional summary.',
    {
      ...mrIid,
      ...body,
      'reviewer-state': string('Review state to record after publishing.', {
        choices: ['reviewed', 'requested-changes'],
      }),
      ...quickActions,
    },
    ['iid'],
    'review-publish --project my-group/my-project --iid 12 --body "Two issues found" --reviewer-state requested-changes',
    'data: {iid, publishedDraftIds, summary, reviewerState}.',
    'Publishes every pending draft of the token owner on this merge request; list them first. --reviewer-state is ignored unless the user is a reviewer, and it is not an approval.',
    async (ctx, opts) => {
      const text = await readText(opts, 'body', { stdin: ctx.stdin });
      const drafts = await pendingDrafts(ctx, opts.iid);
      const summary = Boolean(text?.trim());

      if (!drafts.length && !summary && !opts['reviewer-state']) {
        throw usage('There are no pending draft notes, summary or reviewer state to publish.');
      }
      await publish(
        ctx,
        opts.iid,
        summary ? text : undefined,
        REVIEWER_STATES[opts['reviewer-state']],
      );

      return {
        data: {
          iid: opts.iid,
          publishedDraftIds: drafts.map((draft) => draft.id),
          summary,
          reviewerState: opts['reviewer-state'] ?? null,
        },
        meta: {},
      };
    },
  ),
  command(
    'review-submit',
    group,
    'Submit a complete review: inline comments, a summary and approve, request-changes or comment.',
    {
      ...mrIid,
      event: string('Review decision.', { choices: ['approve', 'request-changes', 'comment'] }),
      ...body,
      'comments-file': string(
        'UTF-8 JSON array of inline comments: {path, body, line, side: new|old, start_line?}.',
      ),
      'head-sha': sha('Reviewed head SHA; the review fails if the merge request moved on.'),
      ...quickActions,
    },
    ['iid', 'event'],
    'review-submit --project my-group/my-project --iid 12 --event request-changes --body "Please handle the empty case"',
    'data: {iid, event, headSha, publishedDraftIds, summary, reviewerState, approval}.',
    'Refuses when you already have pending drafts. Comments become drafts, are published together with the summary, then approve binds the approval to headSha. Created drafts stay pending if a later step fails; the error lists their IDs.',
    async (ctx, opts) => {
      const text = await readText(opts, 'body', { stdin: ctx.stdin });
      const comments = await readReviewComments(opts['comments-file'], opts);
      const summary = Boolean(text?.trim());

      if (opts.event !== 'approve' && !summary && !comments.length) {
        throw usage('A comment or request-changes review needs a body or --comments-file.');
      }

      const [current, drafts] = await concurrently(
        getMergeRequest(ctx, opts.iid),
        pendingDrafts(ctx, opts.iid),
      );
      const headSha = current.data.sha;

      if (opts['head-sha'] && !headSha?.startsWith(opts['head-sha'].toLowerCase())) {
        throw new CliError(
          'HEAD_CHANGED',
          `The merge request head is now ${headSha}; review the new commits first.`,
          8,
          { headSha },
        );
      }
      if (drafts.length) {
        throw new CliError(
          'PENDING_DRAFTS',
          `${drafts.length} pending draft note(s) would be published with this review; publish or delete them first.`,
          8,
          { draftIds: drafts.map((draft) => draft.id) },
        );
      }

      const version = comments.length ? await diffVersion(ctx, opts.iid, headSha) : undefined;
      // Every position is validated before the first draft is created.
      const positions = comments.map((comment) =>
        diffPosition(version, {
          path: comment.path,
          side: comment.side,
          line: comment.line,
          startLine: comment.start_line,
        }),
      );
      const created = [];
      const reviewerState = { 'request-changes': 'requested_changes', comment: 'reviewed' }[
        opts.event
      ];

      try {
        for (const [index, comment] of comments.entries()) {
          const draft = await ctx.mutate('POST', draftsPath(ctx, opts.iid), {
            note: comment.body,
            position: positions[index],
          });

          created.push(draft.data.id);
        }
        if (created.length || summary || reviewerState) {
          await publish(ctx, opts.iid, summary ? text : undefined, reviewerState);
        }
      } catch (error) {
        throw withDetails(
          error,
          { createdDraftIds: created },
          'Created drafts remain pending; inspect them with review-draft-list.',
        );
      }

      let approval = null;

      if (opts.event === 'approve') {
        try {
          approval = (await approve(ctx, opts.iid, headSha)).data;
        } catch (error) {
          throw withDetails(
            error,
            { publishedDraftIds: created, summaryPublished: summary },
            'The review was published without an approval.',
          );
        }
      }

      return {
        data: {
          iid: opts.iid,
          event: opts.event,
          headSha,
          publishedDraftIds: created,
          summary,
          reviewerState: reviewerState ?? null,
          approval,
        },
        meta: {},
      };
    },
  ),
];
