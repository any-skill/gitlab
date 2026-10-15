import { globalOptions } from './options.js';

// Help text and the generated SKILL.md reference both use this invocation.
export const INVOCATION = 'npx -y github:any-skill/gitlab';

export function formatOptions(options, required = []) {
  return Object.entries(options).map(([name, definition]) => {
    const value = definition.type === 'string' ? ' <value>' : '';
    const details = [
      required.includes(name) ? 'required' : 'optional',
      definition.default !== undefined ? `default: ${definition.default}` : '',
      definition.choices ? `choices: ${definition.choices.join('|')}` : '',
      definition.multiple ? 'repeatable' : '',
      definition.integer
        ? `range: ${definition.min}${definition.max ? `..${definition.max}` : '+'}`
        : '',
    ]
      .filter(Boolean)
      .join('; ');

    return `--${name}${value} (${details}): ${definition.description}`;
  });
}

export function help(commands, selected) {
  if (selected) {
    return `${selected.name}: ${selected.description}\n\nUsage: ${INVOCATION} ${selected.name} [options]\n\n${formatOptions(
      { ...selected.options, ...globalOptions },
      selected.required,
    ).join(
      '\n',
    )}\n\nExample: ${INVOCATION} ${selected.example}\nResult: ${selected.result}\nLimitations: ${selected.notes}\n`;
  }

  return `Any Skill GitLab CLI\n\nUsage: ${INVOCATION} <command> [options]\n\n${commands
    .map((entry) => `${entry.name.padEnd(25)} ${entry.description}`)
    .join(
      '\n',
    )}\n\nGlobal options:\n${formatOptions(globalOptions).join('\n')}\n\nUse <command> --help for parameters. API commands require GITLAB_TOKEN; GITLAB_HOST selects a self-managed instance (default https://gitlab.com).\n`;
}
