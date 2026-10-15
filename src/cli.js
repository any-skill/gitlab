import pkg from '../package.json' with { type: 'json' };
import { commands } from './commands.js';
import { parseArguments } from './arguments.js';
import { createContext } from './client.js';
import { CliError, apiError, redact } from './errors.js';
import { help } from './help.js';
import { parseHost } from './host.js';
import { resolveProject } from './project.js';

export const TOKEN_VARIABLE = 'GITLAB_TOKEN';
export const HOST_VARIABLE = 'GITLAB_HOST';

export async function main(argv, runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const environment = runtime.env ?? process.env;
  const token = environment[TOKEN_VARIABLE]?.trim();

  try {
    if (Number(process.versions.node.split('.')[0]) < 24) {
      throw new CliError('UNSUPPORTED_NODE', 'Node.js 24 or newer is required.', 2);
    }

    const { command, options } = parseArguments(argv, commands);

    if (options.version) {
      stdout.write(`${pkg.version}\n`);

      return 0;
    }
    if (options.help) {
      stdout.write(help(commands, command));

      return 0;
    }
    if (!token) {
      throw new CliError('TOKEN_REQUIRED', `Set ${TOKEN_VARIABLE} in the process environment.`, 3);
    }

    const host = parseHost(environment[HOST_VARIABLE]);
    const project =
      command.project === false
        ? null
        : await resolveProject(options.project, host, runtime.cwd, runtime.git);
    const context = createContext({
      options,
      token,
      host,
      project,
      conditional: Boolean(command.options['if-none-match']),
      stdin: runtime.stdin,
      fetch: runtime.fetch,
    });
    const result = await command.run(context, options);
    const output = {
      schemaVersion: 1,
      data: result.data,
      meta: {
        command: command.name,
        host: host.url,
        ...(project ? { project: project.label } : {}),
        observedAt: new Date().toISOString(),
        ...result.meta,
      },
    };
    const serialized = JSON.stringify(output, null, options.pretty ? 2 : undefined);

    stdout.write(`${redact(serialized, token)}\n`);

    return 0;
  } catch (error) {
    const failure = apiError(error, token);
    const serialized = JSON.stringify({
      schemaVersion: 1,
      error: { code: failure.code, message: failure.message, ...failure.details },
    });

    stderr.write(`${redact(serialized, token)}\n`);

    return failure.exitCode;
  }
}
