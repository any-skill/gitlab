# Any Skill GitLab CLI

A standalone, non-interactive GitLab client for AI agents, shell scripts and
applications. Run it directly from GitHub with npx. No GitLab CLI (`glab`), global
installation, MCP server or agent runtime is required. This package is not published to
npm and has no runtime dependencies beyond Node.js.

It covers projects, branches, commits, labels, milestones and members; issues with their
notes and threads; merge requests with commits, diffs, notes, threads (discussions),
reviewers, approvals and draft-note reviews; and CI/CD pipelines, jobs, trigger jobs,
bounded job logs, test reports, commit statuses and retries. It works with GitLab.com and
self-managed instances. Use standard Git for clone, checkout, source edits, commit and
push. The CLI deliberately has no merge, delete-branch or project-administration
commands.

## Requirements and authentication

- Node.js 24+, npm/npx and Git for GitHub package resolution.
- Network access to GitHub and npm for installation, and to the GitLab API for operation.
- `GITLAB_TOKEN` in the process environment. Personal, project and group access tokens
  and OAuth access tokens work; CI job tokens do not. `read_api` is enough for reading;
  writes need `api`. The CLI never logs in interactively or loads `.env` automatically.
- Optional `GITLAB_HOST` for a self-managed instance: a host name or the web URL
  including a relative URL root, for example `gitlab.example.com` or
  `https://example.com/gitlab`. It defaults to `https://gitlab.com`. The token is sent
  only to this host, never to a host found in a Git remote.

## Quick start

Set the environment variables using your credential mechanism, then:

```bash
npx -y github:any-skill/gitlab --help
npx -y github:any-skill/gitlab token-get
npx -y github:any-skill/gitlab issue-list --project my-group/my-project
npx -y github:any-skill/gitlab mr-get --project my-group/my-project --iid 12
npx -y github:any-skill/gitlab mr-checks --project my-group/my-project --iid 12
npx -y github:any-skill/gitlab mr-discussion-list --project my-group/my-project --iid 12 --state unresolved --all
```

For reproducible execution, quote the package reference and use a tag or full SHA:

```bash
npx -y 'github:any-skill/gitlab#v0.1.0' mr-list --project my-group/my-project
npx -y 'github:any-skill/gitlab#<full-commit-sha>' project-get --project my-group/my-project
```

`--project` accepts nested group paths, numeric IDs and project URLs. Inside a checkout
whose remote points at `GITLAB_HOST` it can be omitted.

## Typical operations

```bash
npx -y github:any-skill/gitlab issue-note-list --project my-group/my-project --iid 12 --system exclude --all
npx -y github:any-skill/gitlab mr-list --project my-group/my-project --source-branch feature
npx -y github:any-skill/gitlab mr-diffs --project my-group/my-project --iid 12 --all
npx -y github:any-skill/gitlab job-log --project my-group/my-project --job-id 789 --max-lines 200
npx -y github:any-skill/gitlab pipeline-test-report --project my-group/my-project --pipeline-id 456 --failed-only
```

When explicitly assigned to write:

```bash
npx -y github:any-skill/gitlab issue-create --project my-group/my-project --title 'Fix startup' --description-file issue.md
npx -y github:any-skill/gitlab mr-create --project my-group/my-project --source-branch feature --target-branch main --title 'Fix startup' --description-file mr.md --draft
npx -y github:any-skill/gitlab mr-discussion-create --project my-group/my-project --iid 12 --path src/app.js --new-line 42 --body 'Handle the empty input'
npx -y github:any-skill/gitlab review-submit --project my-group/my-project --iid 12 --event request-changes --body 'See the inline notes' --comments-file comments.json
```

GitLab executes quick actions such as `/close` or `/merge` written at the start of a line
in notes and descriptions. The CLI refuses such text unless `--allow-quick-actions` is
given.

The complete command reference, result shapes, permissions, error handling, pagination
rules and agent workflows are in [SKILL.md](SKILL.md). Copy that single file into an
agent's `gitlab/` skill folder; no supporting files are required.

## JSON and automation

API successes return `{schemaVersion:1,data,meta}` on stdout. Errors return JSON on
stderr with a nonzero exit code. Help/version are text. GitLab keys are converted to
camelCase. A failed pipeline is successfully read data, not a CLI execution error. Rate
limits include retry metadata when available; requests are never retried automatically,
and the supplied token is redacted from output.

Lists default to one page of 50. Follow `meta.pagination` or pass `--all`. Some filters
run locally after paging and are documented per command. Selected reads accept
`--if-none-match` and report `meta.notModified` on HTTP 304.

Polling callers own state and scheduling. Thread resolution, approvals and review states
have no timestamp filter; compare snapshots. This CLI has no persistent state,
scheduler, webhooks, workflow engine or platform-specific integration.

## Development and validation

```bash
git clone https://github.com/any-skill/gitlab.git
cd gitlab
npm ci
npm test
node bin/gitlab.js --help
```

There is no build step: sources are JavaScript ESM `.js` files (`"type": "module"`).
`npm test` runs Node's built-in tests with mocked GitLab HTTP responses; it makes no
live requests. Keep SKILL.md aligned with the command definitions when changing commands
or options.

`src/cli.js` owns streams and exit codes; `src/client.js` owns HTTP requests, pagination,
redirect handling and response normalization with Node's built-in `fetch`;
`src/host.js` and `src/project.js` select the instance and project; `src/diff.js`
computes inline comment positions and `src/log.js` reads bounded job logs. Each module in
`src/commands/` defines one resource domain. A maintained client library such as
Gitbeaker was not used because it retries 429/502 responses, including writes, and
throttles requests on its own, which conflicts with this CLI's no-retry contract.
`private: true` prevents accidental npm publication while the single bin entry still
supports GitHub npx installation.
