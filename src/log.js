const NEWLINE = 0x0a;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SECTION = /section_(?:start|end):\d+:[^\r\n]*?\r(?:\x1b\[0K)?/g;
// Runner log lines may start with "<RFC 3339 timestamp> <stream><O|E><space|+>".
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z [0-9a-f]{2}[OE][ +]/;

// Removes terminal colors and GitLab's collapsible-section markers. A carriage return inside
// a line overwrote the earlier text on a terminal, so only the last segment is kept.
export function cleanLog(text) {
  const lines = [];

  for (const raw of text.split('\n')) {
    const marker = raw.includes('section_start:') || raw.includes('section_end:');
    let line = raw.replace(SECTION, '').replace(ANSI, '').replace(/\r$/, '');

    line = line.slice(line.lastIndexOf('\r') + 1);
    if (marker && !line.replace(TIMESTAMP, '').trim()) {
      continue;
    }
    lines.push(line);
  }

  return lines.join('\n');
}

// Reads from the start until maxBytes or maxLines raw lines, without downloading the rest.
export async function readHead(body, maxBytes, maxLines) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  let lines = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      let end = Math.min(value.length, maxBytes - size);

      for (
        let index = value.indexOf(NEWLINE);
        index !== -1 && index < end;
        index = value.indexOf(NEWLINE, index + 1)
      ) {
        if (++lines === maxLines) {
          end = index + 1;
          break;
        }
      }
      chunks.push(value.subarray(0, end));
      size += end;
      if (end < value.length) {
        truncated = true;
        break;
      }
      if (size >= maxBytes || lines >= maxLines) {
        truncated = !(await reader.read()).done;
        break;
      }
    }
    if (truncated) {
      await reader.cancel();
    }
  } finally {
    reader.releaseLock();
  }

  return { bytes: Buffer.concat(chunks, size), truncated };
}

// Reads a whole body but keeps only its last maxBytes bytes.
export async function readTail(body, maxBytes) {
  const reader = body.getReader();
  let chunks = [];
  let size = 0;
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }
      chunks.push(value);
      size += value.length;
      total += value.length;
      if (size > maxBytes * 2) {
        chunks = [Buffer.concat(chunks, size).subarray(size - maxBytes)];
        size = maxBytes;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks, size);

  return {
    bytes: bytes.subarray(Math.max(0, bytes.length - maxBytes)),
    truncated: total > maxBytes,
  };
}

// Turns raw bytes into at most maxLines lines from the requested end. A tail that starts
// inside the log drops its first, partial line.
export function logText(bytes, { from, truncated, maxLines, raw }) {
  let start = 0;

  if (from === 'tail' && truncated) {
    start = bytes.indexOf(NEWLINE) + 1;
  }

  const decoded = new TextDecoder('utf-8').decode(bytes.subarray(start), {
    stream: from === 'head' && truncated,
  });
  const text = raw ? decoded : cleanLog(decoded);
  const lines = text ? text.replace(/\n$/, '').split('\n') : [];
  const kept = from === 'head' ? lines.slice(0, maxLines) : lines.slice(-maxLines);

  return {
    text: kept.join('\n'),
    truncated: truncated || kept.length < lines.length,
    returnedLines: kept.length,
  };
}
