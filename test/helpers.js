import assert from 'node:assert/strict';
import { TOKEN_VARIABLE, main } from '../src/cli.js';

export const TOKEN = 'test-secret-token-for-mocks';
export const PROJECT = ['--project', 'group/project'];
export const BASE = '/api/v4/projects/group%2Fproject';

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response([204, 304].includes(status) ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function textResponse(text, status = 200, headers = {}) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

// Serves the expected requests in order and checks each one against its step. A request
// beyond the expected ones fails the command instead of reaching the network; the first
// mismatch is rethrown by done().
export function httpMock(steps) {
  const requests = [];
  let failure;

  return {
    requests,
    async fetch(url, init) {
      const step = steps[requests.length];
      const parsed = new URL(url);
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;

      requests.push({ url: parsed, method: init.method, headers: init.headers, body });
      try {
        assert.ok(step, `Unexpected request ${init.method} ${parsed.pathname}${parsed.search}`);
        if (step.method) {
          assert.equal(init.method, step.method);
        }
        if (step.path) {
          assert.equal(parsed.pathname, step.path);
        }
        for (const [key, value] of Object.entries(step.query ?? {})) {
          assert.deepEqual(
            parsed.searchParams.getAll(key),
            value === undefined ? [] : [value].flat().map(String),
            `query ${key}`,
          );
        }
        if (step.body !== undefined) {
          assert.deepEqual(body, step.body);
        }
        step.inspect?.({ url: parsed, init, body });
      } catch (error) {
        failure ??= error;
        throw error;
      }

      return step.response ?? jsonResponse(step.data ?? {}, step.status ?? 200, step.headers);
    },
    done() {
      if (failure) {
        throw failure;
      }
      assert.equal(requests.length, steps.length, 'Not all expected requests occurred');
    },
  };
}

export async function invoke(args, mock = httpMock([]), extra = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await main(args, {
    env: extra.env ?? { [TOKEN_VARIABLE]: TOKEN },
    fetch: mock.fetch,
    stdin: extra.stdin,
    cwd: extra.cwd,
    git: extra.git,
    stdout: {
      write(value) {
        stdout += value;
      },
    },
    stderr: {
      write(value) {
        stderr += value;
      },
    },
  });

  return {
    exitCode,
    stdout,
    stderr,
    output: stdout.startsWith('{') ? JSON.parse(stdout) : undefined,
    error: stderr ? JSON.parse(stderr).error : undefined,
  };
}
