import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { cleanLog, logText, readHead, readTail } from '../src/log.js';

function body(...chunks) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(Buffer.from(chunk));
        }
        controller.close();
      },
    }),
  ).body;
}

test('cleaning removes colors and section markers but keeps runner timestamps', () => {
  const raw = [
    '2026-10-11T18:44:05.973571Z 00O \u001b[0KRunning with gitlab-runner 19.5.0\u001b[0;m',
    '2026-10-11T18:44:34.207Z 00O section_end:1791744274:step_script\r\u001b[0K',
    '2026-10-11T18:44:34.215430Z 00O+section_start:1791744274:cleanup_file_variables[collapsed=true]\r\u001b[0K',
    'section_start:1700000000:build\r\u001b[0K\u001b[36;1mBuilding\u001b[0;m',
    'Downloading 10%\rDownloading 100%',
    'windows line\r',
    '\u001b[31;1mERROR: Job failed: exit code 1\u001b[0;m',
  ].join('\n');

  assert.equal(
    cleanLog(raw),
    [
      '2026-10-11T18:44:05.973571Z 00O Running with gitlab-runner 19.5.0',
      'Building',
      'Downloading 100%',
      'windows line',
      'ERROR: Job failed: exit code 1',
    ].join('\n'),
  );
});

test('the head reader stops at the line or byte limit without reading the rest', async () => {
  const lines = await readHead(body('a\nb\n', 'c\nd\n'), 1000, 3);
  const bytes = await readHead(body('abcdef'), 4, 100);
  const exact = await readHead(body('a\nb\n'), 1000, 2);

  assert.deepEqual([lines.bytes.toString(), lines.truncated], ['a\nb\nc\n', true]);
  assert.deepEqual([bytes.bytes.toString(), bytes.truncated], ['abcd', true]);
  assert.deepEqual([exact.bytes.toString(), exact.truncated], ['a\nb\n', false]);
});

test('the tail reader keeps only the last bytes', async () => {
  const short = await readTail(body('abc'), 10);
  const long = await readTail(body('0123456789', 'abcdefghij', 'XYZ'), 5);

  assert.deepEqual([short.bytes.toString(), short.truncated], ['abc', false]);
  assert.deepEqual([long.bytes.toString(), long.truncated], ['ijXYZ', true]);
});

test('log text returns complete lines from the requested end', () => {
  const tail = logText(Buffer.from('partial\nline1\nline2\nline3\n'), {
    from: 'tail',
    truncated: true,
    maxLines: 2,
  });
  const head = logText(Buffer.from('line1\nline2\nline3'), {
    from: 'head',
    truncated: false,
    maxLines: 2,
  });
  const raw = logText(Buffer.from('\u001b[31mred\u001b[0m\n'), {
    from: 'head',
    truncated: false,
    maxLines: 5,
    raw: true,
  });

  assert.deepEqual(tail, { text: 'line2\nline3', truncated: true, returnedLines: 2 });
  assert.deepEqual(head, { text: 'line1\nline2', truncated: true, returnedLines: 2 });
  assert.equal(raw.text, '\u001b[31mred\u001b[0m');
  assert.deepEqual(logText(Buffer.alloc(0), { from: 'tail', truncated: false, maxLines: 5 }), {
    text: '',
    truncated: false,
    returnedLines: 0,
  });
});
