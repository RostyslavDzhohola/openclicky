# Theo Browne's Codex + Claude Code orchestration

Research date: 2026-07-10

## Short answer

Theo has publicly shown **both directions**, but they are different generations and scopes of his workflow:

1. **Codex -> Claude/Opus review (the small "first loop")**: tell Codex, after it designs an API, to get a second opinion from Opus using `claude -p`. This is the flow the question refers to.
2. **Claude/Fable -> Codex workers (Theo's newer, larger orchestration system)**: Fable is the lead/orchestrator inside Claude Code. It shells out through Bash to `codex exec` / `codex review`, often through small custom Claude Code skills and a low-effort Sonnet wrapper agent. Theo explicitly says he inverted the earlier Codex-led approach and now lets Fable steer.

The first is a single cross-model review handoff. The second is a model router plus dynamic multi-stage workflows and subagents.

## Confirmed evidence

### 1. The Codex -> `claude -p` "first loop"

On 2026-06-21, Theo posted this instruction for Codex:

> "When you are done designing the API, get a second opinion from Opus with 'claude -p'"

He said it had significantly improved the code quality he got from OpenAI models. The original X post is currently difficult to retrieve directly, but its text and timestamp are preserved in [TechTwitter's post archive](https://www.techtwitter.com/tweet/4156ede6-d971-4048-88da-25891fa4ceaf) and a [Digg archive of the X thread](https://digg.com/tech/novqwtay).

This confirms:

- **Control direction:** Codex is the parent agent; Claude Code/Opus is the reviewer.
- **Trigger point:** after Codex has designed an API.
- **Transport:** a non-interactive Claude Code CLI call using `claude -p`.
- **Purpose:** an independent second opinion on a high-taste design decision, not general implementation.

It does **not** publish the complete literal shell command. The quoted text is an instruction *to Codex* containing the invocation name. Theo does not show whether his actual generated command adds `--model opus`, pipes a diff, names files, or relies on his local Claude default. Therefore, the safest reconstruction is:

```text
Codex designs API
  -> Codex builds a self-contained review prompt
  -> Codex invokes `claude -p ...` in the repository
  -> Opus returns review text on stdout
  -> Codex considers that feedback before finishing
```

Do not silently turn Theo's wording into `claude -p --model opus ...`; that is a sensible implementation, but it is not an exact command he published in this source.

### 2. Theo says he later inverted the architecture

In Theo's 2026-07-06 video, [A proper guide to Fable 5](https://www.youtube.com/watch?v=8GRmLR__OGQ), he says that when he used GPT-5.5 more heavily, he had it call Opus for API/SDK feedback. He then says he has "inverted" the setup and now lets Fable steer everything (16:31-16:42; searchable mirror: [transcript](https://sozai.app/transcript/proper-guide-fable-5/)).

The current main direction is therefore:

```text
Human goal
  -> Claude Code / Fable lead
     -> dynamic Claude workflow (JavaScript)
        -> Claude subagents for taste/reasoning
        -> thin Sonnet-low wrapper
           -> Bash
              -> `codex exec` / `codex review`
                 -> GPT-5.5 worker or independent reviewer
           <- result/report
        <- verified result
     <- synthesis and decision
```

### 3. Where the routing rules live

Theo shows the primary policy in his **global `CLAUDE.md`**. Around 12:16-13:52 in the video, he explains:

- If computer use is helpful for completing or verifying work, Claude should "shell out" to GPT-5.5 through Codex.
- "Shell out" is deliberate: Claude Code already has Bash, so it can invoke the Codex CLI directly.
- His `CLAUDE.md` defines how to choose models for workflows and subagents.
- A subagent is a separate agent for one bounded task; a workflow is generated JavaScript that programmatically feeds results from one stage into later stages.

The point is not a fixed DAG of permanent reviewer roles. Theo prefers letting Fable invent the investigator/reviewer/judge mix for the particular task, while the global file supplies model capabilities, costs, and routing preferences.

### 4. Model routing rules Theo showed

Theo's 2026-07-01 X post and attached `CLAUDE.md` excerpt are preserved in a [Digg archive](https://digg.com/tech/wmowks0x). The same rules are discussed at 16:49-20:18 in the July 6 video:

- Bulk/mechanical or clear-spec implementation, migrations, and data analysis -> GPT-5.5 through Codex.
- User-facing UI, copy, API design, and code-quality decisions require more "taste" -> Fable or Opus.
- Plan/implementation review -> Fable or Opus, optionally GPT-5.5 as an extra independent perspective.
- For investigation or data analysis not covered by a skill, run `codex exec -s read-only` with a self-contained prompt.
- His `~/.codex/config.toml` defaulted to GPT-5.5 at the time, so the shown commands did not need to repeat the model every time.

Theo framed these as defaults, not hard limits: judge output and escalate when the cheaper worker misses the quality bar.

### 5. The thin-wrapper mechanism

Claude's workflow model parameter could select Claude models, not GPT-5.5. Theo's workaround was:

- Spawn a thin Claude wrapper agent using Sonnet with low effort.
- Instruct that wrapper to write a **self-contained Codex prompt**.
- Have it run `codex exec` through Bash.
- Return the Codex result to the parent workflow.
- Prefix Codex-backed tasks so Theo can see which workflow nodes actually used GPT-5.5.
- Account for possible timeouts.

This is confirmed by the attached `CLAUDE.md` excerpt in the July 1 archived post and Theo's explanation at 19:19-20:18 in the July 6 video. It is a wrapper because the Claude workflow system still needs a Claude agent node, but the expensive work happens in the child Codex process.

### 6. His three Codex-facing skills

Theo shows three custom Claude Code skills:

- `codex-review`: ask Codex for an independent review of uncommitted changes, a branch diff, a commit, or a specific implementation.
- `codex-implementation`: bounded implementation work, usually in a worktree, returning useful results to the lead.
- `codex-computer-use`: local app verification involving browser automation, simulators, screenshots, launching apps, and runtime inspection.

For review, the described flow is: identify the review target -> create a temporary artifact directory -> run Codex review with a focused prompt -> read the report -> verify important claims against the code before presenting them. Theo stresses that a "no findings" result must say so clearly, including what target was inspected, so the parent does not mistakenly rerun it (20:41-23:48 in the July 6 video).

He does not publish these skill files for blind copying; in the video he explicitly asks viewers to build and adapt their own.

### 7. Concrete orchestration example

Theo asked Fable to triage 16 stale Lakebed PRs and to use a workflow with multiple reviewers. The generated workflow used 48 agents:

- 16 investigators, one per PR.
- Each verdict was stress-tested by a Fable + Opus judge panel.
- 14 of 16 decisions were unanimous; Fable resolved the two contested cases.

This is described at 24:46-26:03 in the July 6 video. It demonstrates that the workflow layer is dynamically generated and multi-stage; it is not merely `claude -p` in a loop.

## What `claude -p` actually means

Anthropic's current [non-interactive mode documentation](https://code.claude.com/docs/en/headless) defines `-p` / `--print` as a one-off, non-interactive Claude Code run that prints a response and exits. It can use Claude Code's agent loop and tools, not just make a plain text completion.

Relevant semantics:

- Without `--bare`, it loads the same local/project context as an interactive session, including `CLAUDE.md`, skills, plugins, hooks, MCP servers, and auto-memory.
- It reads stdin and writes stdout, so another agent can compose it as a Unix subprocess.
- `--model opus` can pin the Opus alias; otherwise the active/default model selection applies.
- `--output-format json` provides structured result and session metadata.
- `--allowedTools` or a permission mode is needed for unattended tool use beyond what the active policy already permits.
- `--continue` / `--resume` can make later calls stateful, but Theo's June "first loop" evidence does not show him using them.

A faithful *implementation pattern* for Theo's idea—not a verbatim command from Theo—would be:

```bash
claude -p --model opus \
  "Review the API design in the current changes. Identify contract mistakes, unnecessary complexity, missing edge cases, and compatibility risks. Return concise, actionable feedback. Do not edit files."
```

If a deterministic script is desired, Anthropic now recommends considering `--bare` and explicitly passing required context and tools. That recommendation post-dates the original workflow and changes behavior because `--bare` skips `CLAUDE.md`, skills, plugins, hooks, MCP servers, and auto-memory.

## Version and billing caveats

- Theo's evidence is from **June 21 through July 6, 2026**, using the then-current GPT-5.5, Opus 4.8, Fable 5, Sonnet 5, Codex CLI, and Claude Code behavior. Model names, aliases, rate limits, and workflow capabilities are time-sensitive.
- Anthropic originally announced that Agent SDK and `claude -p` usage would move to a separate monthly credit on **2026-06-15**, and its [headless CLI documentation](https://code.claude.com/docs/en/headless) still contains that older wording. However, Anthropic's newer [Help Center update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says the change was paused: for now, Agent SDK, `claude -p`, and third-party Agent SDK usage continue to draw from subscription usage limits. Treat the Help Center update as the current billing state and expect this policy to change again.
- Anthropic says `--bare` is recommended for scripted/SDK calls and will become the default for `-p` in a future release. Theo's setup depends on ambient global `CLAUDE.md` and skills, so that future default would require an explicit adaptation.
- Theo's June instruction says "Opus with `claude -p`" but omits `--model opus`; the model pinning mechanism is confirmed by Anthropic, while Theo's exact local invocation is not.
- The X evidence above uses archival mirrors because the original X status URLs were not reliably retrievable during research. Claims attributed to Theo's video are backed by Theo's own YouTube upload; the searchable transcript is a convenience mirror and may contain speech-to-text errors such as "Codeex" for Codex.

## Practical conclusion for Clicky

Theo's pattern validates **cross-harness subprocess delegation**, but it is not the same architecture as Clicky's persistent sidecar sessions:

- Theo primarily uses one harness as the lead and shells out to the other CLI for bounded work/review.
- Clicky hosts both SDK backends as peers and persists topic sessions/threads itself.
- The directly reusable idea is the **review handoff protocol**: self-contained prompt, narrow target, independent model, explicit no-findings response, parent verification, then synthesis.
- The most important design choice is direction: use Codex -> Opus when Codex is leading implementation and needs taste/design review; use Claude/Fable -> Codex when Claude is leading and needs cheap mechanical execution, independent review, or computer use.

## Primary sources and evidence quality

- Theo Browne, [A proper guide to Fable 5](https://www.youtube.com/watch?v=8GRmLR__OGQ), 2026-07-06. Primary source; strongest evidence for current architecture and direction.
- Theo Browne X post, 2026-06-21, preserved by [TechTwitter](https://www.techtwitter.com/tweet/4156ede6-d971-4048-88da-25891fa4ceaf) and [Digg](https://digg.com/tech/novqwtay). First-party statement via archival mirrors; strongest evidence for the `claude -p` instruction.
- Theo Browne X post and `CLAUDE.md` screenshot, 2026-07-01, preserved by [Digg](https://digg.com/tech/wmowks0x). First-party content via archival mirror; supports exact routing rules and command names.
- Anthropic, [Run Claude Code programmatically](https://code.claude.com/docs/en/headless), current as researched 2026-07-10. Primary official documentation for `claude -p` semantics.
- Anthropic, [CLI reference](https://code.claude.com/docs/en/cli-usage), current as researched 2026-07-10. Primary official documentation for model, output, session, and permission flags.
- Anthropic, [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), current as researched 2026-07-10. Primary official source stating that the planned June 15 credit split was paused.
