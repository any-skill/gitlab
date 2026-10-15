import { createHash } from 'node:crypto';
import { usage } from './errors.js';

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Parses one file diff from GitLab into its lines. codeOld/codeNew follow GitLab's own diff
// parser: each line carries both counters as they were before the line was consumed.
export function parseDiff(diff) {
  const lines = [];
  const hunks = [];
  let oldLine = 0;
  let newLine = 0;

  for (const text of diff.replace(/\n$/, '').split('\n')) {
    const hunk = text.match(HUNK);

    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      hunks.push({
        oldStart: oldLine,
        oldLines: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newStart: newLine,
        newLines: hunk[4] === undefined ? 1 : Number(hunk[4]),
      });
      continue;
    }
    if (!hunks.length || text.startsWith('\\')) {
      continue;
    }
    if (text.startsWith('+')) {
      lines.push({ type: 'new', old: null, new: newLine, codeOld: oldLine, codeNew: newLine });
      newLine++;
    } else if (text.startsWith('-')) {
      lines.push({ type: 'old', old: oldLine, new: null, codeOld: oldLine, codeNew: newLine });
      oldLine++;
    } else {
      // A context line; GitLab positions call every line that was not added "old".
      lines.push({ type: 'old', old: oldLine, new: newLine, codeOld: oldLine, codeNew: newLine });
      oldLine++;
      newLine++;
    }
  }

  return { lines, hunks };
}

// In unified diffs an empty range starts at the line before it.
function hunkEnd(start, length) {
  return length === 0 ? start + 1 : start + length;
}

// An unchanged line outside every hunk is shifted by the hunks that precede it.
function outsideHunks(hunks, side, line) {
  let offset = 0;

  for (const hunk of hunks) {
    const start = side === 'new' ? hunk.newStart : hunk.oldStart;
    const length = side === 'new' ? hunk.newLines : hunk.oldLines;
    const end = hunkEnd(start, length);

    if (length > 0 && line >= start && line < end) {
      return null;
    }
    if (line >= end) {
      offset = hunkEnd(hunk.newStart, hunk.newLines) - hunkEnd(hunk.oldStart, hunk.oldLines);
    }
  }

  const other = side === 'new' ? line - offset : line + offset;
  const [oldLine, newLine] = side === 'new' ? [other, line] : [line, other];

  return other > 0
    ? { type: 'old', old: oldLine, new: newLine, codeOld: oldLine, codeNew: newLine }
    : null;
}

function locate(parsed, side, line, file) {
  const found =
    parsed.lines.find((entry) => entry[side] === line) ??
    (file.new_file || file.deleted_file ? null : outsideHunks(parsed.hunks, side, line));

  if (!found) {
    throw usage(`Line ${line} on the ${side} side of ${file.new_path} is not part of this diff.`);
  }

  return found;
}

function rangeEnd(path, entry) {
  return {
    line_code: `${createHash('sha1').update(path).digest('hex')}_${entry.codeOld}_${entry.codeNew}`,
    type: entry.type,
    old_line: entry.old,
    new_line: entry.new,
  };
}

// Builds a GitLab text position for a line of a merge request diff version. side is new
// (an added or unchanged line by its new number) or old (a removed or unchanged line).
export function diffPosition(version, { path, side, line, startLine }) {
  const file = version.diffs?.find((entry) => entry.new_path === path || entry.old_path === path);

  if (!file) {
    throw usage(`${path} is not changed in merge request diff version ${version.id}.`);
  }
  if (file.too_large || (file.collapsed && !file.diff)) {
    throw usage(`GitLab does not provide the diff of ${path}; comment on it in the web UI.`);
  }
  if (startLine !== undefined && startLine > line) {
    throw usage('--start-line must not be greater than the anchor line.');
  }

  const parsed = parseDiff(file.diff ?? '');
  const end = locate(parsed, side, line, file);
  const position = {
    position_type: 'text',
    base_sha: version.base_commit_sha,
    start_sha: version.start_commit_sha,
    head_sha: version.head_commit_sha,
    old_path: file.old_path,
    new_path: file.new_path,
    ...(end.old === null ? {} : { old_line: end.old }),
    ...(end.new === null ? {} : { new_line: end.new }),
  };

  if (startLine !== undefined && startLine !== line) {
    const codePath = file.new_path || file.old_path;

    position.line_range = {
      start: rangeEnd(codePath, locate(parsed, side, startLine, file)),
      end: rangeEnd(codePath, end),
    };
  }

  return position;
}
