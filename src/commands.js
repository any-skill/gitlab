import { accountCommands } from './commands/account.js';
import { projectCommands } from './commands/project.js';
import { issueCommands } from './commands/issues.js';
import { noteCommands } from './commands/notes.js';
import { discussionCommands } from './commands/discussions.js';
import { mergeRequestCommands } from './commands/merge-requests.js';
import { approvalCommands } from './commands/approvals.js';
import { reviewCommands } from './commands/reviews.js';
import { pipelineCommands } from './commands/pipelines.js';

const inGroup = (entries, group) => entries.filter((entry) => entry.group === group);

// One module per resource domain. Help and the generated SKILL.md reference list the
// commands in this order, grouped by their group name.
export const commands = [
  ...accountCommands,
  ...projectCommands,
  ...issueCommands,
  ...inGroup(noteCommands, 'Issue Notes'),
  ...inGroup(discussionCommands, 'Issue Discussions'),
  ...mergeRequestCommands,
  ...inGroup(noteCommands, 'MR Notes'),
  ...inGroup(discussionCommands, 'MR Discussions'),
  ...approvalCommands,
  ...reviewCommands,
  ...pipelineCommands,
];
