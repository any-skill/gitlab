import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArguments } from '../src/arguments.js';
import { commands } from '../src/commands.js';
import { globalOptions } from '../src/options.js';

// The command is found with the union of all options, so a name needs one value type.
test('an option name has the same type in every command', () => {
  const types = new Map();

  for (const entry of commands) {
    for (const [name, definition] of Object.entries({ ...globalOptions, ...entry.options })) {
      assert.equal(
        types.get(name) ?? definition.type,
        definition.type,
        `--${name} in ${entry.name}`,
      );
      types.set(name, definition.type);
    }
  }
});

test('global options may precede the command and defaults are applied', () => {
  const { command, options } = parseArguments(
    ['--project', 'group/project', 'issue-list', '--label', 'bug', '--label', 'ui', '--all'],
    commands,
  );

  assert.equal(command.name, 'issue-list');
  assert.deepEqual(options.label, ['bug', 'ui']);
  assert.equal(options['per-page'], 50);
  assert.equal(options.page, 1);
  assert.equal(options.state, 'opened');
  assert.equal(options.timeout, 30000);
});

test('integers are converted and empty values are only allowed where documented', () => {
  assert.equal(parseArguments(['issue-get', '--iid', '12'], commands).options.iid, 12);
  assert.equal(
    parseArguments(['issue-update', '--iid', '1', '--description', ''], commands).options
      .description,
    '',
  );
  assert.throws(() => parseArguments(['issue-note-create', '--iid', '1', '--body', ''], commands), {
    exitCode: 2,
  });
});

test('conflicting options name both sides', () => {
  assert.throws(
    () =>
      parseArguments(['mr-update', '--iid', '1', '--reviewer', 'a', '--clear-reviewers'], commands),
    /--clear-reviewers cannot be combined with --reviewer/,
  );
});

test('every command has complete documentation and parses its own example', () => {
  const names = new Set();

  for (const entry of commands) {
    assert.ok(!names.has(entry.name), `${entry.name} is defined twice`);
    names.add(entry.name);
    assert.ok(entry.description && entry.example && entry.result && entry.notes, entry.name);
    assert.match(entry.name, /^[a-z]+(?:-[a-z]+)+$/);
  }
});
