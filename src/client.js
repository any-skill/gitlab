import pkg from '../package.json' with { type: 'json' };
import { CliError, expectObject } from './errors.js';

const NEXT_LINK = /<([^>]+)>;\s*rel="next"/;
const MAX_REDIRECTS = 3;

export class HttpError extends Error {
  constructor(message, status, headers, body) {
    super(message);
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

// Await independent requests concurrently, but surface the first failure in argument order
// so the reported error does not depend on which response arrives first.
export async function concurrently(...promises) {
  const results = await Promise.allSettled(promises);
  const failure = results.find((result) => result.status === 'rejected');

  if (failure) {
    throw failure.reason;
  }

  return results.map((result) => result.value);
}

// GitLab keys are snake_case; results use camelCase. Leading underscores (_links) stay.
export function normalize(value) {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key.replace(/(?<=[A-Za-z0-9])_([a-z0-9])/g, (_match, letter) => letter.toUpperCase()),
        normalize(child),
      ]),
    );
  }

  return value;
}

function flatten(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(flatten).join('; ');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${key} ${flatten(item)}`)
      .join('; ');
  }

  return '';
}

// GitLab errors use message (a string, list or field map), error or error_description.
export function errorMessage(body, status) {
  if (body && typeof body === 'object') {
    const text = flatten(body.message ?? body.error_description ?? body.error);

    if (text) {
      return text;
    }
  }
  if (typeof body === 'string' && body.trim() && body.length <= 300 && !/<html/i.test(body)) {
    return body.trim();
  }

  return `GitLab returned HTTP ${status}.`;
}

function headerInteger(headers, name) {
  const value = headers.get(name)?.trim();

  return value && /^\d+$/.test(value) ? Number(value) : null;
}

export function nextPageOf(headers) {
  const header = headers.get('x-next-page');

  if (header !== null) {
    return headerInteger(headers, 'x-next-page');
  }

  const next = headers.get('link')?.match(NEXT_LINK)?.[1];

  if (!next) {
    return null;
  }

  const page = new URL(next).searchParams.get('page');

  if (!/^\d+$/.test(page ?? '')) {
    throw new CliError('INVALID_RESPONSE', 'GitLab returned an unsupported pagination link.');
  }

  return Number(page);
}

export function rateLimitOf(headers) {
  const [limit, remaining, reset] = [
    'ratelimit-limit',
    'ratelimit-remaining',
    'ratelimit-reset',
  ].map((name) => headerInteger(headers, name));

  if ([limit, remaining, reset].includes(null)) {
    return undefined;
  }

  return {
    limit,
    remaining,
    resetAt: new Date(reset * 1000).toISOString(),
    name: headers.get('ratelimit-name') ?? null,
  };
}

async function readBody(response) {
  if (response.status === 204 || response.status === 304) {
    return null;
  }

  const text = await response.text();

  if (!text) {
    return null;
  }
  if (!(response.headers.get('content-type') ?? '').includes('json')) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    if (!response.ok) {
      return text;
    }

    throw new CliError('INVALID_RESPONSE', 'GitLab returned invalid JSON.');
  }
}

export function createContext(settings) {
  const {
    options,
    token,
    host,
    project = null,
    conditional = false,
    stdin = process.stdin,
    fetch: fetchImplementation = fetch,
  } = settings;
  const etag = options['if-none-match'];

  function target(path, query = {}) {
    const url = new URL(path, host.api);

    if (url.origin !== host.origin) {
      throw new CliError('INTERNAL_ERROR', 'Refusing a request outside GITLAB_HOST.', 1);
    }
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(`${key}[]`, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  async function send(method, url, { body, headers = {} } = {}) {
    const init = {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': `any-skill-gitlab/${pkg.version}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeout),
    };
    let current = url;
    let response = await fetchImplementation(current, init);

    // GitLab redirects GET requests for moved projects. Only same-origin API redirects are
    // followed, so the token never leaves GITLAB_HOST.
    for (
      let hops = 0;
      response.status >= 300 && response.status < 400 && response.status !== 304;
      hops++
    ) {
      const location = response.headers.get('location');
      const next = location ? new URL(location, current) : null;

      await response.body?.cancel();
      if (
        method !== 'GET' ||
        hops >= MAX_REDIRECTS ||
        next?.origin !== host.origin ||
        !next.pathname.startsWith(`${host.prefix}/api/`)
      ) {
        throw new CliError(
          'UNEXPECTED_REDIRECT',
          `GitLab answered HTTP ${response.status} with a redirect that the CLI does not follow.`,
          8,
          { status: response.status },
        );
      }
      current = next;
      response = await fetchImplementation(current, init);
    }

    return response;
  }

  async function request(method, path, { query, body, headers, allowNotModified = false } = {}) {
    const response = await send(method, target(path, query), {
      body,
      headers: { ...headers, ...(allowNotModified && etag ? { 'if-none-match': etag } : {}) },
    });

    if (response.status === 304 && allowNotModified && etag) {
      return { status: 304, headers: response.headers, body: null };
    }

    const parsed = await readBody(response);

    if (!response.ok) {
      throw new HttpError(
        errorMessage(parsed, response.status),
        response.status,
        response.headers,
        parsed,
      );
    }

    return { status: response.status, headers: response.headers, body: parsed };
  }

  // Returns the unread response of a streaming endpoint such as a job log.
  async function stream(path, headers = {}) {
    const response = await send('GET', target(path), { headers: { accept: '*/*', ...headers } });

    if (!response.ok && response.status !== 416) {
      const parsed = await readBody(response);

      throw new HttpError(
        errorMessage(parsed, response.status),
        response.status,
        response.headers,
        parsed,
      );
    }

    return response;
  }

  function meta(headers) {
    const result = {};
    const rateLimit = rateLimitOf(headers);

    if (conditional && headers.get('etag')) {
      result.etag = headers.get('etag');
    }
    if (rateLimit) {
      result.rateLimit = rateLimit;
    }

    return result;
  }

  async function single(path, query) {
    const response = await request('GET', path, { query, allowNotModified: true });

    if (response.status === 304) {
      return { data: null, meta: { ...meta(response.headers), notModified: true } };
    }

    return { data: normalize(expectObject(response.body)), meta: meta(response.headers) };
  }

  async function mutate(method, path, body) {
    const response = await request(method, path, { body });

    return { data: normalize(response.body), meta: meta(response.headers) };
  }

  // Reads one page, or every remaining page with --all. An error on a later page discards
  // earlier pages so a partial list is never reported as a success. Filters run on raw
  // GitLab entries before key normalization.
  async function list(path, query = {}, filter = () => true) {
    const items = [];
    let page = options.page;
    let nextPage = null;
    let response;

    for (;;) {
      response = await request('GET', path, {
        query: { ...query, page, per_page: options['per-page'] },
        allowNotModified: page === options.page,
      });
      if (response.status === 304) {
        return { data: null, meta: { ...meta(response.headers), notModified: true } };
      }
      if (!Array.isArray(response.body)) {
        throw new CliError('INVALID_RESPONSE', 'Expected a JSON array page.');
      }
      items.push(
        ...response.body.map((entry) => expectObject(entry, 'GitLab list entry')).filter(filter),
      );
      nextPage = nextPageOf(response.headers);
      if (!options.all || nextPage === null) {
        break;
      }
      if (nextPage <= page) {
        throw new CliError('INVALID_RESPONSE', 'GitLab pagination did not advance.');
      }
      page = nextPage;
    }

    return {
      data: normalize(items),
      meta: {
        ...meta(response.headers),
        pagination: {
          page,
          perPage: options['per-page'],
          hasNextPage: nextPage !== null,
          nextPage,
          totalCount: headerInteger(response.headers, 'x-total'),
          totalPages: headerInteger(response.headers, 'x-total-pages'),
          returnedCount: items.length,
          complete: nextPage === null,
        },
      },
    };
  }

  async function graphql(query, variables = {}) {
    const response = await request('POST', host.graphql, { body: { query, variables } });
    const result = expectObject(response.body, 'GitLab GraphQL response');

    if (Array.isArray(result.errors) && result.errors.length) {
      const message = result.errors.map((entry) => entry?.message ?? 'Unknown error').join('; ');

      if (/does not exist or you don't have permission/i.test(message)) {
        throw new CliError('NOT_FOUND', 'Resource not found or not visible to this token.', 5, {
          reason: message,
        });
      }

      throw new CliError('API_ERROR', message, 8);
    }

    return expectObject(result.data, 'GitLab GraphQL data');
  }

  function projectPath(suffix = '') {
    if (!project) {
      throw new CliError('INTERNAL_ERROR', 'This command is not bound to a project.', 1);
    }

    return `projects/${encodeURIComponent(project.id)}${suffix}`;
  }

  return {
    options,
    host,
    project,
    stdin,
    request,
    stream,
    single,
    mutate,
    list,
    graphql,
    projectPath,
    // Composite commands read complete collections independently of the user's paging.
    withOptions: (overrides) =>
      createContext({
        ...settings,
        options: { ...options, 'if-none-match': undefined, ...overrides },
        conditional: false,
      }),
  };
}
