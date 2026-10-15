import { accountCommand } from '../options.js';

const group = 'Account';

export const accountCommands = [
  accountCommand(
    'user-get',
    group,
    'Read the user who owns GITLAB_TOKEN.',
    {},
    [],
    'user-get',
    'data: user object with id, username, name, state, webUrl and bot.',
    'Identifies the token owner, for example to recognize own merge requests. --project is ignored.',
    (ctx) => ctx.single('user'),
  ),
  accountCommand(
    'token-get',
    group,
    'Read the name, scopes, expiry and state of GITLAB_TOKEN; never its value.',
    {},
    [],
    'token-get',
    'data: {id, name, scopes, active, revoked, expiresAt, lastUsedAt, userId, ...}.',
    'Works for personal, project and group access tokens; OAuth and CI job tokens are rejected. Use it to explain PERMISSION_DENIED. --project is ignored.',
    (ctx) => ctx.single('personal_access_tokens/self'),
  ),
];
