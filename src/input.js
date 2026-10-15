import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { usage } from './errors.js';

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
// GitLab limits notes to 1,000,000 characters and descriptions to 1,048,576.
const MAX_CHARACTERS = 1000000;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUICK_ACTION = /^\s*\/([a-z][a-z0-9_]*)(?=\s|$)/i;

// Files and standard input share one bounded reader so an oversized file is rejected
// without being loaded into memory first.
async function readBounded(stream) {
  const chunks = [];
  let size = 0;

  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;

    size += buffer.length;
    if (size > MAX_INPUT_BYTES) {
      throw usage('Text input exceeds 4 MiB.');
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, size).toString('utf8');
}

// GitLab executes lines that start with a quick action such as /close or /merge when a
// note or description is saved. Lines inside fenced code blocks are not executed.
export function findQuickActions(text) {
  const found = new Set();
  let fence = null;

  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(FENCE)?.[1];

    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? null : marker;
      continue;
    }

    const command = !fence && line.match(QUICK_ACTION)?.[1];

    if (command) {
      found.add(`/${command.toLowerCase()}`);
    }
  }

  return [...found];
}

export function guardQuickActions(text, options, label) {
  const found = text && !options['allow-quick-actions'] ? findQuickActions(text) : [];

  if (found.length) {
    throw usage(
      `${label} has lines that GitLab executes as quick actions (${found.slice(0, 5).join(', ')}). Rephrase them, put them in a code block, or pass --allow-quick-actions when the assignment requires them.`,
    );
  }
}

// Reads --<field> or --<field>-file (- for standard input).
export async function readText(options, field, { required = false, stdin = process.stdin } = {}) {
  let value = options[field];
  const source = options[`${field}-file`];

  if (source) {
    if (source === '-' && stdin.isTTY) {
      throw usage(`--${field}-file - requires piped standard input.`);
    }
    try {
      value = await readBounded(source === '-' ? stdin : createReadStream(source));
    } catch (error) {
      if (error.exitCode) {
        throw error;
      }

      throw usage(`Cannot read --${field}-file.`);
    }
  }
  if (value !== undefined && value.length > MAX_CHARACTERS) {
    throw usage(`--${field} exceeds ${MAX_CHARACTERS} characters.`);
  }
  if (required && !value?.trim()) {
    throw usage(`A non-empty --${field} or --${field}-file is required.`);
  }
  guardQuickActions(value, options, `--${field}`);

  return value;
}

export async function readReviewComments(path, options) {
  if (!path) {
    return [];
  }

  let value;

  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw usage('--comments-file must be a readable UTF-8 JSON file.');
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw usage('--comments-file must contain an array of 1 to 100 inline comments.');
  }
  value.forEach((comment, index) => {
    const valid =
      comment &&
      typeof comment === 'object' &&
      !Array.isArray(comment) &&
      typeof comment.path === 'string' &&
      comment.path.trim() &&
      typeof comment.body === 'string' &&
      comment.body.trim() &&
      comment.body.length <= MAX_CHARACTERS &&
      Number.isSafeInteger(comment.line) &&
      comment.line > 0 &&
      ['new', 'old'].includes(comment.side) &&
      (comment.start_line === undefined ||
        (Number.isSafeInteger(comment.start_line) &&
          comment.start_line > 0 &&
          comment.start_line <= comment.line)) &&
      Object.keys(comment).every((key) =>
        ['path', 'body', 'line', 'side', 'start_line'].includes(key),
      );

    if (!valid) {
      throw usage(
        `Inline comment ${index + 1} needs path, non-empty body, positive line and side new|old; start_line (<= line) is optional and no other keys are allowed.`,
      );
    }
    guardQuickActions(comment.body, options, `Inline comment ${index + 1}`);
  });

  return value;
}

export function requireChanges(fields) {
  if (!Object.values(fields).some((value) => value !== undefined)) {
    throw usage('Supply at least one field to update.');
  }
}
