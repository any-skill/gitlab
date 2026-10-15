import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { findQuickActions, readReviewComments, readText } from '../src/input.js';

const directory = await mkdtemp(join(tmpdir(), 'any-skill-gitlab-input-'));

after(() => rm(directory, { recursive: true, force: true }));

test('quick action lines are found outside fenced code blocks only', () => {
  const text = [
    'Looks good.',
    '/close',
    '  /label ~bug ~"needs review"',
    'A path like /usr/bin/env is text.',
    '/usr/bin/env node',
    '```',
    '/merge',
    '```',
    '~~~~ shell',
    '/approve',
    '~~~~',
    '/Assign @alex',
  ].join('\n');

  assert.deepEqual(findQuickActions(text), ['/close', '/label', '/assign']);
  assert.deepEqual(findQuickActions('No commands here.\n> quoted text'), []);
});

test('text options refuse quick actions unless explicitly allowed', async () => {
  await assert.rejects(readText({ body: 'Done.\n/close' }, 'body'), (error) => {
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /\/close/);

    return true;
  });
  assert.equal(
    await readText({ body: 'Done.\n/close', 'allow-quick-actions': true }, 'body'),
    'Done.\n/close',
  );
});

test('text is read from a file or standard input and validated', async () => {
  const file = join(directory, 'note.md');

  await writeFile(file, 'Use `code` and $HOME literally.\n');
  assert.equal(await readText({ 'body-file': file }, 'body'), 'Use `code` and $HOME literally.\n');
  assert.equal(
    await readText({ 'description-file': '-' }, 'description', {
      stdin: Readable.from(['from ', 'stdin']),
    }),
    'from stdin',
  );
  assert.equal(await readText({ description: '' }, 'description'), '');
  await assert.rejects(readText({ body: '   ' }, 'body', { required: true }), { exitCode: 2 });
  await assert.rejects(readText({ 'body-file': join(directory, 'missing.md') }, 'body'), {
    exitCode: 2,
  });
  await assert.rejects(
    readText({ 'body-file': '-' }, 'body', {
      stdin: Object.assign(Readable.from([]), { isTTY: true }),
    }),
    { exitCode: 2 },
  );
  await assert.rejects(readText({ body: 'x'.repeat(1000001) }, 'body'), { exitCode: 2 });
});

test('review comment files are validated before any request', async () => {
  const valid = join(directory, 'valid.json');
  const invalid = join(directory, 'invalid.json');
  const quick = join(directory, 'quick.json');

  await writeFile(
    valid,
    JSON.stringify([
      { path: 'src/app.js', body: 'Rename this.', line: 10, side: 'new' },
      { path: 'src/app.js', body: 'Block comment.', line: 20, side: 'old', start_line: 18 },
    ]),
  );
  await writeFile(invalid, JSON.stringify([{ path: 'a.js', body: 'x', line: 1, side: 'RIGHT' }]));
  await writeFile(
    quick,
    JSON.stringify([{ path: 'a.js', body: '/approve', line: 1, side: 'new' }]),
  );

  assert.equal((await readReviewComments(valid, {})).length, 2);
  assert.deepEqual(await readReviewComments(undefined, {}), []);
  await assert.rejects(readReviewComments(invalid, {}), { exitCode: 2 });
  await assert.rejects(readReviewComments(quick, {}), { exitCode: 2 });
  await assert.rejects(readReviewComments(join(directory, 'missing.json'), {}), { exitCode: 2 });
  assert.equal((await readReviewComments(quick, { 'allow-quick-actions': true })).length, 1);
});
