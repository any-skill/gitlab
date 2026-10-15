import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { usage } from './errors.js';

const execute = promisify(execFile);
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const INVALID =
  '--project must be a path such as group/subgroup/project, a numeric project ID or a project URL.';

export function parseProjectPath(value) {
  const segments = value.split('/');

  if (segments.length < 2 || !segments.every((segment) => SEGMENT.test(segment))) {
    throw usage(INVALID);
  }

  return { id: value, path: value, label: value };
}

export function parseProject(value, host) {
  const text = value.trim();

  if (/^\d+$/.test(text)) {
    if (!Number.isSafeInteger(Number(text)) || Number(text) < 1) {
      throw usage(INVALID);
    }

    return { id: String(Number(text)), path: null, label: String(Number(text)) };
  }
  if (!/^https?:\/\//i.test(text)) {
    return parseProjectPath(text);
  }

  let url;
  let path;

  try {
    url = new URL(text);
    path = decodeURIComponent(url.pathname);
  } catch {
    throw usage(INVALID);
  }
  if (url.origin !== host.origin || !path.startsWith(`${host.prefix}/`)) {
    // The token belongs to GITLAB_HOST; a URL for another instance must not receive it.
    throw usage(`--project URL must belong to ${host.url}; set GITLAB_HOST for another instance.`);
  }

  return parseProjectPath(
    path
      .slice(host.prefix.length)
      .split('/-/')[0]
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/, ''),
  );
}

// Recognizes SSH (scp-like and ssh://) and HTTP(S) remotes of the configured host. The host
// is never taken from a remote: repository content cannot redirect the token.
export function projectFromRemote(remote, host) {
  let hostname;
  let path;
  const scp = /^[a-z][a-z0-9+.-]*:\/\//i.test(remote)
    ? null
    : remote.match(/^(?:[^@\s/]+@)?([^:\s/]+):(.+)$/);

  try {
    if (scp) {
      [, hostname, path] = scp;
    } else {
      const url = new URL(remote);

      hostname = url.hostname;
      path = decodeURIComponent(url.pathname);
      if (['https:', 'http:'].includes(url.protocol)) {
        if (url.origin !== host.origin || !path.startsWith(`${host.prefix}/`)) {
          return null;
        }
        path = path.slice(host.prefix.length);
      } else if (!['ssh:', 'git+ssh:'].includes(url.protocol)) {
        return null;
      }
    }
    if (hostname.toLowerCase() !== host.hostname) {
      return null;
    }

    return parseProjectPath(path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, ''));
  } catch {
    // A remote can be valid Git syntax without identifying a supported project.
    return null;
  }
}

export async function resolveProject(explicit, host, cwd = process.cwd(), git = execute) {
  if (explicit) {
    return parseProject(explicit, host);
  }

  let remotes;

  try {
    ({ stdout: remotes } = await git('git', ['remote', '-v'], {
      cwd,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    throw usage('Cannot infer a GitLab project here. Supply --project group/project.');
  }

  const candidates = [];

  for (const line of remotes.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    const project = match && projectFromRemote(match[2], host);

    if (project) {
      candidates.push({ name: match[1], project });
    }
  }

  const origin = candidates.find((entry) => entry.name === 'origin');

  if (origin) {
    return origin.project;
  }

  const unique = new Map(
    candidates.map((entry) => [entry.project.path.toLowerCase(), entry.project]),
  );

  if (unique.size === 1) {
    return [...unique.values()][0];
  }

  throw usage(`No unambiguous ${host.hostname} Git remote. Supply --project group/project.`);
}
