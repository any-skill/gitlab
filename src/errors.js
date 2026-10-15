export class CliError extends Error {
  constructor(code, message, exitCode = 8, details = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function usage(message) {
  return new CliError('INVALID_ARGUMENT', message, 2);
}

export function redact(text, token) {
  return token ? text.replaceAll(token, '[REDACTED]') : text;
}

function headerNumber(headers, name) {
  const value = headers?.get(name);

  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : undefined;
}

// Maps failures to the error codes and exit codes shared by every Any Skill CLI. HTTP
// failures from the client carry status, headers and the parsed GitLab error body.
export function apiError(error, token = '') {
  if (error instanceof CliError) {
    return error;
  }

  const status = error.status;
  const message = redact(String(error.message ?? 'Unexpected failure'), token);
  const details = status ? { status } : {};
  const requestId = error.headers?.get('x-request-id');

  if (requestId) {
    details.requestId = requestId;
  }
  if (status === 429) {
    const retryAfter = headerNumber(error.headers, 'retry-after');
    const reset = headerNumber(error.headers, 'ratelimit-reset');

    if (retryAfter !== undefined) {
      details.retryAfterSeconds = retryAfter;
    }
    if (reset !== undefined) {
      details.resetAt = new Date(reset * 1000).toISOString();
    }

    return new CliError('RATE_LIMITED', message, 6, details);
  }
  if (status === 401) {
    return new CliError('AUTHENTICATION_FAILED', 'GITLAB_TOKEN was rejected by GitLab.', 3, {
      ...details,
      reason: message,
    });
  }
  if (status === 403) {
    if (error.body?.error === 'insufficient_scope') {
      return new CliError(
        'PERMISSION_DENIED',
        `The token lacks the scope this request needs${error.body.scope ? ` (${error.body.scope})` : ''}.`,
        4,
        { ...details, requiredScope: error.body.scope ?? null },
      );
    }

    return new CliError('PERMISSION_DENIED', message, 4, details);
  }
  if (status === 404) {
    return new CliError('NOT_FOUND', 'Resource not found or not visible to this token.', 5, {
      ...details,
      reason: message,
    });
  }
  if (status) {
    return new CliError('API_ERROR', message, 8, details);
  }
  if (
    ['TimeoutError', 'AbortError'].includes(error.name) ||
    (error instanceof TypeError && error.message === 'fetch failed')
  ) {
    return new CliError('NETWORK_ERROR', 'The GitLab request failed or timed out.', 7);
  }

  return new CliError('INTERNAL_ERROR', message, 1);
}

export function expectObject(data, label = 'GitLab response') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new CliError('INVALID_RESPONSE', `${label} must be an object.`);
  }

  return data;
}
