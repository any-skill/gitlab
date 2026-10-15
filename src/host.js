import { usage } from './errors.js';

export const DEFAULT_HOST = 'https://gitlab.com';

// Plain HTTP is accepted only for local development instances such as a GDK.
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$|\.(?:localhost|test)$/i;

// GITLAB_HOST is a host name or the web URL of the instance, including a relative URL
// root such as https://example.com/gitlab. The token is only ever sent to this origin.
export function parseHost(value) {
  const text = value?.trim() || DEFAULT_HOST;
  let url;

  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw usage('GITLAB_HOST must be a host name or an http(s) URL of a GitLab instance.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw usage('GITLAB_HOST must be an http(s) URL without credentials.');
  }
  if (url.search || url.hash) {
    throw usage('GITLAB_HOST must not contain a query or fragment.');
  }
  if (url.protocol === 'http:' && !LOCAL_HOST.test(url.hostname)) {
    throw usage('GITLAB_HOST must use https except for local development hosts.');
  }

  const prefix = url.pathname.replace(/\/+$/, '');

  if (/\/api(?:\/|$)/.test(prefix)) {
    throw usage('GITLAB_HOST is the web URL of the instance, without /api/v4.');
  }

  return {
    url: `${url.origin}${prefix}`,
    origin: url.origin,
    hostname: url.hostname.toLowerCase(),
    prefix,
    api: `${url.origin}${prefix}/api/v4/`,
    graphql: `${url.origin}${prefix}/api/graphql`,
  };
}
