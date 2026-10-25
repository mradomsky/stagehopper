# Cloud probe: heinzelwerk plugin in a cloud Claude Code session

Date: 2026-10-25
Session: cloud Claude Code, environment `heinzelwerk-probe`, repository `mradomsky/stagehopper`,
branch `claude/gallant-wozniak-xn24ex`. Probe recorded facts only; no plugin or project files changed.

## Sandbox facts (from `~/probe-env.txt` and env)

| fact | value |
|---|---|
| pwd (setup) | /home/user |
| home | /root |
| user | root |
| claude | 2.1.310 (Claude Code) |
| gh | gh version 2.89.0 (2026-03-26) |
| jq | jq-1.7 |
| node | v22.22.0 |
| terraform | n/a |
| plugin commit | 3734b2a feat: install from the GitHub marketplace in one step (#24) |
| CLAUDE_CODE_REMOTE | true |
| CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS | 1 |
| CLAUDE_CODE_PLUGIN_DIRS | /root/heinzelwerk |
| CLAUDE_PLUGIN_ROOT (main session) | empty |
| main-session model (get_session) | claude-fable-5-1, effort high, permission_mode auto |

## Check 1 — Sandbox facts

Command:

```bash
cat ~/probe-env.txt; echo "REMOTE=$CLAUDE_CODE_REMOTE TEAMS=$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS PLUGIN_DIRS=$CLAUDE_CODE_PLUGIN_DIRS"; pwd; git rev-parse --abbrev-ref HEAD; ls ~/heinzelwerk/bin ~/heinzelwerk/hooks
```

Output:

```
pwd: /home/user
home: /root
user: root
claude: 2.1.310 (Claude Code)
gh: gh version 2.89.0 (2026-03-26)
jq: jq-1.7
node: v22.22.0
terraform: n/a
plugin: 3734b2a feat: install from the GitHub marketplace in one step (#24)
REMOTE=true TEAMS=1 PLUGIN_DIRS=/root/heinzelwerk
/home/user/stagehopper
claude/gallant-wozniak-xn24ex
/root/heinzelwerk/bin:
merge-gate
tf-gate
ui-shots

/root/heinzelwerk/hooks:
guard-test.sh
guard.sh
hooks.json
```

Note: `PLUGIN_DIRS` is `/root/heinzelwerk` (the `~` expanded), which is `~/heinzelwerk`.

Verdict: ✓

## Check 2 — Plugin loaded

No command run; read from the agent/skill listing in the session's system context.

Agents visible (6): `heinzelwerk:backend`, `heinzelwerk:frontend`, `heinzelwerk:infra`,
`heinzelwerk:product`, `heinzelwerk:tech-lead`, `heinzelwerk:validator`.

Skills visible (17): `heinzelwerk:adopt-docs`, `heinzelwerk:code-review`, `heinzelwerk:codebase-design`,
`heinzelwerk:coordinator`, `heinzelwerk:diagnosing-bugs`, `heinzelwerk:domain-modeling`,
`heinzelwerk:grilling`, `heinzelwerk:improve-codebase-architecture`, `heinzelwerk:model-selection`,
`heinzelwerk:phased-workflow`, `heinzelwerk:ponytail-debt`, `heinzelwerk:prototype`, `heinzelwerk:tdd`,
`heinzelwerk:team-modes`, `heinzelwerk:to-spec`, `heinzelwerk:to-tickets`, `heinzelwerk:writing-for-agents`.

Not visible: skills `setup` and `retro` (expected list named them); commands `shape`, `feature`, `bugfix`
(not visible, consistent with model invocation disabled). Hook attribution in check 4 names the plugin
`heinzelwerk@inline`.

Verdict: ✓

## Check 3 — bin on PATH

Command:

```bash
command -v merge-gate tf-gate ui-shots; echo "PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT"
```

Output:

```
/root/heinzelwerk/bin/merge-gate
/root/heinzelwerk/bin/tf-gate
/root/heinzelwerk/bin/ui-shots
PLUGIN_ROOT=
```

`CLAUDE_PLUGIN_ROOT` is empty in the Bash tool's environment (the hook itself receives it, see check 4).

Verdict: ✓

## Check 4 — Guard hook

Command 1:

```bash
terraform apply x
```

Output (tool error, command never ran):

```
PreToolUse:Bash hook error: ["/root/heinzelwerk"/hooks/guard.sh]: blocked by heinzelwerk: raw terraform apply/destroy/import/state changes are not allowed; use tf-gate apply <dir> <plan>

This hook comes from the heinzelwerk@inline plugin.
```

Command 2:

```bash
git push origin main
```

Output (tool error, command never ran):

```
PreToolUse:Bash hook error: ["/root/heinzelwerk"/hooks/guard.sh]: blocked by heinzelwerk: agents never push main

This hook comes from the heinzelwerk@inline plugin.
```

Verdict: ✓

## Check 5 — Teammate spawn

Spawned via the Agent tool: `subagent_type: heinzelwerk:backend`, `name: probe`, background, with the
prompt from the task description verbatim.

Report returned by `probe` (as a subagent hand-back message, not a team message):

```
Probe report. Two of the requested steps did not happen: the task and the message to team-lead.

model: Sonnet 5.5 (claude-sonnet-5-5)
effort: low
echo $CLAUDE_PLUGIN_ROOT: empty
command -v merge-gate: /root/heinzelwerk/bin/merge-gate
members array of ~/.claude/teams/<team>/config.json: not found. ~/.claude/teams does not exist, so there is no team dir or config.
MCP tool servers: Claude_Docs, Notion, github, claude-code-remote. The loaded schemas are the claude-code-remote ones and the Claude_Docs batch/guide/update tools. The rest are listed as deferred.

Task "probe: hello": not created, claimed or completed, and no done note was written. I have no task create/claim/complete tool in this session (ToolSearch found none).

Message to team-lead: SendMessage failed with "No agent named 'team-lead' is reachable". This handback is the only delivery of the report.
```

Agent run stats (harness notification): 55834 tokens, 4 tool uses, 11989 ms.

Main-session verification:

```bash
ls -la ~/.claude/teams/
# ls: cannot access '/root/.claude/teams/': No such file or directory
find / -path /proc -prune -o -type d -name teams -print
# (no output)
ls ~/.claude
# backups environment-manager launcher-settings.json plugins projects session-env sessions shell-snapshots skills ...
```

`TaskList` (main session): `No tasks found`. `TaskGet` not possible (no task id). `TaskStop probe`:
`Task probe is not running (status: completed)`.

Mode: ran as an ordinary subagent, not a teammate. No `~/.claude/teams/` dir, no task, no team-lead
message (SendMessage to `team-lead` failed inside the agent); report arrived only as subagent hand-back.

| item | value |
|---|---|
| model | Sonnet 5.5 (claude-sonnet-5-5) |
| effort | low (expected medium) |
| CLAUDE_PLUGIN_ROOT | empty |
| merge-gate | /root/heinzelwerk/bin/merge-gate |
| MCP tools | servers Claude_Docs, Notion, github, claude-code-remote (task tools absent) |

Verdict: ✗ (not a teammate; effort low, not medium; model Sonnet and merge-gate path as expected)

## Check 6 — gh REST

Commands and output:

```
$ gh api repos/{owner}/{repo} --jq .full_name
mradomsky/stagehopper
exit=0
$ gh api -H 'Accept: application/vnd.github.raw+json' 'repos/{owner}/{repo}/contents/docs/agents/heinzelwerk/merge-policy.json?ref=main' --jq .enabled
true
exit=0
$ gh api 'repos/{owner}/{repo}/pulls?state=closed&per_page=1' --jq '.[0].number'
264
exit=0
```

Verdict: ✓

## Check 7 — gh GraphQL

```
$ gh pr list --limit 1
HTTP 403: GitHub GraphQL is not available from Claude Code sessions; use the REST API (gh api repos/{owner}/{repo}/...). For review threads, auto-merge, and draft/ready-for-review use the CCR routes on api.github.com: GET /repos/{owner}/{repo}/pulls/{n}/ccr/review_threads, POST /repos/{owner}/{repo}/pulls/{n}/ccr/comments/{comment_id}/resolve (or /unresolve), PUT or DELETE /repos/{owner}/{repo}/pulls/{n}/ccr/auto_merge, POST /repos/{owner}/{repo}/pulls/{n}/ccr/ready_for_review, POST /repos/{owner}/{repo}/pulls/{n}/ccr/convert_to_draft. (https://api.github.com/graphql)
exit=1
```

Verdict: rejected

```
$ gh issue list --limit 1
HTTP 403: GitHub GraphQL is not available from Claude Code sessions; use the REST API (gh api repos/{owner}/{repo}/...). For review threads, auto-merge, and draft/ready-for-review use the CCR routes on api.github.com: GET /repos/{owner}/{repo}/pulls/{n}/ccr/review_threads, POST /repos/{owner}/{repo}/pulls/{n}/ccr/comments/{comment_id}/resolve (or /unresolve), PUT or DELETE /repos/{owner}/{repo}/pulls/{n}/ccr/auto_merge, POST /repos/{owner}/{repo}/pulls/{n}/ccr/ready_for_review, POST /repos/{owner}/{repo}/pulls/{n}/ccr/convert_to_draft. (https://api.github.com/graphql)
exit=1
```

Verdict: rejected

```
$ gh api graphql -f query='{viewer{login}}'
{"message":"GitHub GraphQL is not available from Claude Code sessions; use the REST API (gh api repos/{owner}/{repo}/...). For review threads, auto-merge, and draft/ready-for-review use the CCR routes on api.github.com: GET /repos/{owner}/{repo}/pulls/{n}/ccr/review_threads, POST /repos/{owner}/{repo}/pulls/{n}/ccr/comments/{comment_id}/resolve (or /unresolve), PUT or DELETE /repos/{owner}/{repo}/pulls/{n}/ccr/auto_merge, POST /repos/{owner}/{repo}/pulls/{n}/ccr/ready_for_review, POST /repos/{owner}/{repo}/pulls/{n}/ccr/convert_to_draft.","documentation_url":"https://docs.anthropic.com/en/docs/claude-code/github-actions"}gh: GitHub GraphQL is not available from Claude Code sessions; use the REST API (gh api repos/{owner}/{repo}/...). For review threads, auto-merge, and draft/ready-for-review use the CCR routes on api.github.com: GET /repos/{owner}/{repo}/pulls/{n}/ccr/review_threads, POST /repos/{owner}/{repo}/pulls/{n}/ccr/comments/{comment_id}/resolve (or /unresolve), PUT or DELETE /repos/{owner}/{repo}/pulls/{n}/ccr/auto_merge, POST /repos/{owner}/{repo}/pulls/{n}/ccr/ready_for_review, POST /repos/{owner}/{repo}/pulls/{n}/ccr/convert_to_draft. (HTTP 403)
exit=1
```

Verdict: rejected

Overall: rejected ×3 (expected). The proxy advertises REST `ccr/` routes for review threads, auto-merge,
ready-for-review and convert-to-draft.

## Check 8 — merge-gate on a merged PR

Command (10-minute timeout, run from repo root):

```bash
time merge-gate 202
```

Output:

```
HTTP 403: GitHub GraphQL is not available from Claude Code sessions; use the REST API (gh api repos/{owner}/{repo}/...). For review threads, auto-merge, and draft/ready-for-review use the CCR routes on api.github.com: GET /repos/{owner}/{repo}/pulls/{n}/ccr/review_threads, POST /repos/{owner}/{repo}/pulls/{n}/ccr/comments/{comment_id}/resolve (or /unresolve), PUT or DELETE /repos/{owner}/{repo}/pulls/{n}/ccr/auto_merge, POST /repos/{owner}/{repo}/pulls/{n}/ccr/ready_for_review, POST /repos/{owner}/{repo}/pulls/{n}/ccr/convert_to_draft. (https://api.github.com/graphql)
MERGE SKIP: gate error (line 22)

real	0m0.615s
user	0m0.115s
sys	0m0.075s
exit=0
```

Verdict line: `MERGE SKIP: gate error (line 22)` (the expected quick failure; `gh pr view` rejected).

Verdict: ✓ (expected outcome; merge-gate is unusable in cloud as written)

## Check 9 — Worktree and second branch

Command:

```bash
git fetch origin && git worktree add .claude/worktrees/heinzelwerk/probe/cloud -b probe/cloud origin/main
```

Output (fetch listed ~115 `[new branch]` and 18 `[new tag]` refs from `https://github.com/mradomsky/stagehopper`;
elided here), then:

```
Preparing worktree (new branch 'probe/cloud')
branch 'probe/cloud' set up to track 'origin/main'.
HEAD is now at 9cb318b Merge pull request #264 from mradomsky/docs/agent-docs-253
exit=0
```

`package-lock.json` present in the worktree. `npm ci` inside the worktree:

```
npm notice
npm notice New major version of npm available! 10.9.4 -> 12.2.1
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.1
npm notice To update run: npm install -g npm@12.2.1
npm notice
npm ci exit=0 duration=16s
```

Push:

```
$ git -C .claude/worktrees/heinzelwerk/probe/cloud push -u origin probe/cloud
remote:
remote: Create a pull request for 'probe/cloud' on GitHub by visiting:
remote:      https://github.com/mradomsky/stagehopper/pull/new/probe/cloud
remote:
To https://github.com/mradomsky/stagehopper
 * [new branch]      probe/cloud -> probe/cloud
branch 'probe/cloud' set up to track 'origin/probe/cloud'.
exit=0
```

Cleanup: `git worktree remove --force .claude/worktrees/heinzelwerk/probe/cloud` → exit 0;
`git worktree list` shows only the main checkout. Remote branch `probe/cloud` left in place (human deletes).

Side effect noted: after `cd` into the worktree the harness switched the session's primary working directory
to the worktree and back again after removal ("Environment update" notices).

Verdict: ✓

## Check 10 — Models

`/model`: not runnable from this session. It is a built-in CLI command, not a skill, and is not exposed to the
model in a cloud session (no tool, no skill entry). Output: none.

Own model (from `get_session`, claude-code-remote MCP):

```
session_context.model = claude-fable-5-1
external_metadata.last_served_model = claude-fable-5-1
configured_model = claude-fable-5-1
effort_level = high
```

Teammate model from check 5: `Sonnet 5.5 (claude-sonnet-5-5)`, effort `low`.

Verdict: ✓ (teammate reported Sonnet per its frontmatter)

## Summary

| check | verdict |
|---|---|
| 1 sandbox facts | ✓ |
| 2 plugin loaded | ✓ |
| 3 bin on PATH | ✓ |
| 4 guard hook | ✓ |
| 5 teammate spawn | ✗ (ordinary subagent; no team dir, no tasks, no team-lead; effort low) |
| 6 gh REST | ✓ |
| 7 gh GraphQL | rejected ×3 (expected) |
| 8 merge-gate 202 | ✓ `MERGE SKIP: gate error (line 22)` in 0.6 s |
| 9 worktree + second branch | ✓ (npm ci 16 s, push accepted) |
| 10 models | ✓ (`/model` not runnable; self claude-fable-5-1; teammate Sonnet 5.5) |
