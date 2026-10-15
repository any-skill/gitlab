import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHost } from '../src/host.js';
import { parseProject, projectFromRemote, resolveProject } from '../src/project.js';

const gitlab = parseHost(undefined);

test('GITLAB_HOST accepts host names and web URLs and derives the API URLs', () => {
  assert.deepEqual(gitlab, {
    url: 'https://gitlab.com',
    origin: 'https://gitlab.com',
    hostname: 'gitlab.com',
    prefix: '',
    api: 'https://gitlab.com/api/v4/',
    graphql: 'https://gitlab.com/api/graphql',
  });
  assert.equal(parseHost('gitlab.example.com:8443').api, 'https://gitlab.example.com:8443/api/v4/');
  assert.equal(
    parseHost('https://example.com/gitlab/').graphql,
    'https://example.com/gitlab/api/graphql',
  );
  assert.equal(parseHost('http://gdk.test:3000').url, 'http://gdk.test:3000');
  assert.equal(parseHost('http://127.0.0.1:3000').url, 'http://127.0.0.1:3000');
});

for (const value of [
  'http://gitlab.example.com',
  'ftp://gitlab.example.com',
  'https://user:secret@gitlab.example.com',
  'https://gitlab.example.com/?x=1',
  'https://gitlab.example.com/api/v4',
  'https://exa mple.com',
]) {
  test(`GITLAB_HOST ${value} is rejected`, () => {
    assert.throws(() => parseHost(value), { exitCode: 2 });
  });
}

test('--project accepts nested paths, numeric IDs and project URLs of the configured host', () => {
  assert.deepEqual(parseProject('group/sub/project', gitlab), {
    id: 'group/sub/project',
    path: 'group/sub/project',
    label: 'group/sub/project',
  });
  assert.deepEqual(parseProject('0042', gitlab), { id: '42', path: null, label: '42' });
  assert.equal(
    parseProject('https://gitlab.com/group/sub/project/-/merge_requests/12', gitlab).id,
    'group/sub/project',
  );
  assert.equal(parseProject('https://gitlab.com/group/project.git', gitlab).id, 'group/project');
  assert.equal(
    parseProject(
      'https://example.com/gitlab/group/project',
      parseHost('https://example.com/gitlab'),
    ).id,
    'group/project',
  );
  for (const value of [
    'project',
    'group/../project',
    '/group/project',
    '0',
    'group/-x',
    'https://gitlab.example.com/group/project',
  ]) {
    assert.throws(() => parseProject(value, gitlab), { exitCode: 2 }, value);
  }
});

test('remotes of the configured host are recognized; other hosts are ignored', () => {
  for (const remote of [
    'git@gitlab.com:group/sub/project.git',
    'ssh://git@gitlab.com/group/sub/project.git',
    'ssh://git@gitlab.com:2222/group/sub/project',
    'https://gitlab.com/group/sub/project.git',
    'https://oauth2:secret@gitlab.com/group/sub/project.git',
  ]) {
    assert.equal(projectFromRemote(remote, gitlab)?.id, 'group/sub/project', remote);
  }
  for (const remote of [
    'git@github.com:group/project.git',
    'https://gitlab.example.com/group/project.git',
    'http://gitlab.com/group/project.git',
    '/local/path/repository',
    'git@gitlab.com:project.git',
  ]) {
    assert.equal(projectFromRemote(remote, gitlab), null, remote);
  }
});

test('origin wins, ambiguous remotes fail and an explicit project does not invoke Git', async () => {
  const git = async () => ({
    stdout:
      'upstream\tgit@gitlab.com:up/project.git (fetch)\norigin\tgit@gitlab.com:me/project.git (fetch)\norigin\tgit@gitlab.com:me/project.git (push)\n',
  });

  assert.equal((await resolveProject(undefined, gitlab, '.', git)).id, 'me/project');
  await assert.rejects(
    resolveProject(undefined, gitlab, '.', async () => ({
      stdout: 'a\tgit@gitlab.com:a/project.git (fetch)\nb\tgit@gitlab.com:b/project.git (fetch)\n',
    })),
    { exitCode: 2 },
  );
  await assert.rejects(
    resolveProject(undefined, gitlab, '.', async () => {
      throw new Error('not a repository');
    }),
    { exitCode: 2 },
  );
  assert.equal(
    (
      await resolveProject('explicit/project', gitlab, '.', async () => {
        throw new Error('Must not call Git');
      })
    ).id,
    'explicit/project',
  );
});
