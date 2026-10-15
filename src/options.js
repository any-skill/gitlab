export const string = (description, extra = {}) => ({ type: 'string', description, ...extra });
export const flag = (description, extra = {}) => ({ type: 'boolean', description, ...extra });
export const integer = (description, extra = {}) =>
  string(description, { integer: true, min: 1, ...extra });
export const timestamp = (description) => string(description, { timestamp: true });

// Every Any Skill CLI accepts these options with the same meaning; --project is GitLab's
// counterpart of the GitHub skill's --repo.
export const globalOptions = {
  project: string(
    'GitLab project path (group/subgroup/project), numeric ID or project URL; otherwise inferred from Git remotes.',
  ),
  timeout: integer('Request timeout in milliseconds.', { default: '30000', max: 300000 }),
  pretty: flag('Indent the JSON result.'),
  help: flag('Show command help without authentication.'),
  version: flag('Show the CLI version without authentication.'),
};

export const paging = {
  page: integer('Start at this page.', { default: '1' }),
  'per-page': integer('API page size.', { default: '50', max: 100 }),
  all: flag('Fetch all remaining pages sequentially.', { conflicts: ['if-none-match'] }),
};
export const conditional = {
  'if-none-match': string('ETag from an earlier identical request; HTTP 304 returns notModified.'),
};

export const SHA = /^[0-9a-f]{7,64}$/i;
export const sha = (description) =>
  string(description, { pattern: SHA, hint: 'must be a hexadecimal commit SHA' });

export const issueIid = { iid: integer('Issue IID, the project-local number shown as #123.') };
export const mrIid = { iid: integer('Merge request IID, the project-local number shown as !123.') };
export const noteId = { 'note-id': integer('Numeric note (comment) ID.') };
export const discussionId = {
  'discussion-id': string('Discussion (thread) ID, 40 hexadecimal characters.', {
    pattern: /^[0-9a-f]{40}$/i,
    hint: 'must be a 40-character hexadecimal discussion ID',
  }),
};
export const pipelineId = { 'pipeline-id': integer('Numeric pipeline ID.') };
export const jobId = { 'job-id': integer('Numeric CI job ID.') };

export const body = {
  body: string('Markdown text. Mutually exclusive with --body-file.', {
    conflicts: ['body-file'],
  }),
  'body-file': string('UTF-8 Markdown file, or - to read standard input.'),
};
export const description = {
  description: string(
    'Markdown description; an empty value clears it on update. Mutually exclusive with --description-file.',
    { allowEmpty: true, conflicts: ['description-file'] },
  ),
  'description-file': string('UTF-8 Markdown description file, or - to read standard input.'),
};
export const quickActions = {
  'allow-quick-actions': flag(
    'Send text with lines that GitLab executes as quick actions, such as /close.',
  ),
};
export const since = { since: timestamp('ISO 8601 timestamp; see the command limitations.') };
export const direction = {
  direction: string('Sort direction.', { choices: ['asc', 'desc'], default: 'desc' }),
};
export const diffLocation = {
  path: string('Repository-relative file path in the merge request diff.'),
  'new-line': integer('Line number in the new file version (added or unchanged line).', {
    conflicts: ['old-line'],
  }),
  'old-line': integer('Line number in the old file version (removed or unchanged line).'),
  'start-line': integer(
    'First line of a multi-line comment, on the same side as --new-line or --old-line.',
  ),
  'head-sha': sha('Reviewed head commit SHA; defaults to the latest merge request diff version.'),
};

export function command(
  name,
  group,
  description,
  options,
  required,
  example,
  result,
  notes,
  run,
  extra = {},
) {
  return { name, group, description, options, required, example, result, notes, run, ...extra };
}

// Commands outside a project, such as reading the token owner, set project: false.
export function accountCommand(...args) {
  return { ...command(...args), project: false };
}
