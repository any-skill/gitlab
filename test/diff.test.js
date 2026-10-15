import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { diffPosition } from '../src/diff.js';

const diff = [
  '@@ -2,4 +2,5 @@ export function start() {',
  ' line2',
  '-line3 old',
  '+line3 new',
  '+line3b added',
  ' line4',
  ' line5',
  '@@ -10,3 +11,2 @@',
  ' line10',
  '-line11 removed',
  ' line12',
  '',
].join('\n');
const version = {
  id: 5,
  base_commit_sha: 'base',
  start_commit_sha: 'start',
  head_commit_sha: 'head',
  diffs: [
    { old_path: 'src/app.js', new_path: 'src/app.js', diff },
    { old_path: 'new.txt', new_path: 'new.txt', new_file: true, diff: '@@ -0,0 +1,2 @@\n+a\n+b\n' },
    {
      old_path: 'gone.txt',
      new_path: 'gone.txt',
      deleted_file: true,
      diff: '@@ -1,2 +0,0 @@\n-a\n-b\n',
    },
    { old_path: 'big.bin', new_path: 'big.bin', too_large: true, diff: '' },
  ],
};
const base = {
  position_type: 'text',
  base_sha: 'base',
  start_sha: 'start',
  head_sha: 'head',
  old_path: 'src/app.js',
  new_path: 'src/app.js',
};
const code = (old, current) =>
  `${createHash('sha1').update('src/app.js').digest('hex')}_${old}_${current}`;

for (const [side, line, expected] of [
  ['new', 3, { new_line: 3 }],
  ['old', 3, { old_line: 3 }],
  ['new', 5, { old_line: 4, new_line: 5 }],
  ['new', 1, { old_line: 1, new_line: 1 }],
  ['new', 8, { old_line: 7, new_line: 8 }],
  ['old', 7, { old_line: 7, new_line: 8 }],
  ['new', 11, { old_line: 10, new_line: 11 }],
  ['old', 11, { old_line: 11 }],
  ['new', 20, { old_line: 20, new_line: 20 }],
]) {
  test(`the ${side} line ${line} maps to ${JSON.stringify(expected)}`, () => {
    assert.deepEqual(diffPosition(version, { path: 'src/app.js', side, line }), {
      ...base,
      ...expected,
    });
  });
}

test('a multi-line range carries GitLab line codes for both ends', () => {
  const position = diffPosition(version, {
    path: 'src/app.js',
    side: 'new',
    line: 5,
    startLine: 3,
  });

  assert.deepEqual(position.line_range, {
    start: { line_code: code(4, 3), type: 'new', old_line: null, new_line: 3 },
    end: { line_code: code(4, 5), type: 'old', old_line: 4, new_line: 5 },
  });
  assert.equal(position.new_line, 5);
});

test('new and deleted files only have lines on their own side', () => {
  assert.equal(diffPosition(version, { path: 'new.txt', side: 'new', line: 2 }).new_line, 2);
  assert.equal(diffPosition(version, { path: 'gone.txt', side: 'old', line: 2 }).old_line, 2);
  assert.throws(() => diffPosition(version, { path: 'new.txt', side: 'new', line: 5 }), {
    exitCode: 2,
  });
  assert.throws(() => diffPosition(version, { path: 'gone.txt', side: 'new', line: 1 }), {
    exitCode: 2,
  });
});

test('unknown paths, inaccessible diffs and inverted ranges are rejected', () => {
  for (const options of [
    { path: 'missing.js', side: 'new', line: 1 },
    { path: 'big.bin', side: 'new', line: 1 },
    { path: 'src/app.js', side: 'new', line: 3, startLine: 5 },
  ]) {
    assert.throws(() => diffPosition(version, options), { exitCode: 2 }, JSON.stringify(options));
  }
});
