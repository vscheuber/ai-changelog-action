# AI Changelog Updater

A **reusable GitHub Action** that updates the `## Unreleased` section of your `CHANGELOG.md` using an LLM.

It gathers:

- Git history & diff stats since the last release (or a custom ref)
- Merged pull-request titles, bodies and labels
- Optional activity from related repositories (e.g. a shared library)
- Any content already present under `## Unreleased`

…then asks the LLM to produce a **user-focused** changelog entry while **preserving** existing Unreleased content.

### Special behaviour for full (stable) releases

When the action detects (or is told) that you are preparing a **full release**, it also:

1. Finds every pre-release tag (`-alpha`, `-beta`, `-rc`, …) that appeared after the previous full release.
2. Collects the changelog entries that were written for those pre-releases  
   (first from sections already present in `CHANGELOG.md`, then falling back to GitHub Release bodies).
3. Feeds all of that material to the LLM so it can produce a **clean, de-duplicated, consolidated** set of notes for the final stable version.

This matches the workflow where you keep writing Unreleased / pre-release notes during the alpha/beta cycle and want a polished final changelog when the stable release ships.

---

## Quick start

Use it in any repository:

```yaml
# .github/workflows/update-changelog.yml
name: Update Changelog

on:
  workflow_dispatch:
  # push:
  #   branches: [main]

permissions:
  contents: write
  pull-requests: read

jobs:
  changelog:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Update Unreleased section
        uses: your-username/ai-changelog-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          llm-api-key: ${{ secrets.OPENAI_API_KEY }}
          llm-provider: openai
          model: gpt-4o
          target-user-type: user
          user-focus: "CLI users" # optional explicit override
          related-repos: "Frodo-org/frodo-lib"
          # For a full release you can be explicit:
          # release-type: full
          # version: 2.1.0
          prompt-extra: |
            Focus on changes that affect people who run the CLI.
            Mention frodo-lib changes only when they are visible to CLI users.
          commit: true
```

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | ✅ | – | Token with `pull-requests:read` (and `contents:write` if committing) |
| `llm-api-key` | ✅ | – | API key for the chosen LLM provider |
| `llm-provider` | | `openai` | `openai` or `anthropic` |
| `model` | | `gpt-4o` | Model name for the selected provider. OpenAI examples: `gpt-5`, `gpt-4.1`, `gpt-4o`. Anthropic examples: `claude-sonnet-4-20250514`, `claude-opus-4-20250514`. |
| `changelog-path` | | `CHANGELOG.md` | Path to the changelog file |
| `since` | | `last-release` | Git ref or the special value `last-release` |
| `related-repos` | | `''` | Comma-separated `owner/repo` list |
| `target-user-type` | | `user` | Primary audience type: `user` or `developer` |
| `user-focus` | | `''` | Optional explicit audience phrase override |
| `prompt-extra` | | `''` | Extra instructions appended to the base prompt |
| `release-type` | | `auto` | `auto` \| `full` \| `prerelease`. Controls whether pre-release notes are consolidated |
| `version` | | `''` | Optional version being prepared (helps auto-detection and the prompt) |
| `dry-run` | | `false` | Only print the generated text, do not write the file |
| `commit` | | `false` | Commit & push the updated CHANGELOG.md |
| `commit-message` | | `docs: update CHANGELOG.md (Unreleased)` | Commit message |

## Outputs

| Output | Description |
|--------|-------------|
| `changelog-updated` | `"true"` if the file was modified |
| `unreleased-content` | The final body written under `## Unreleased` |
| `is-full-release` | `"true"` when the action treated the run as a full/stable release |
| `pre-release-tags` | Comma-separated list of pre-release tags that were consolidated |

---

## How full-release consolidation works

```
Previous full release:  v1.4.0
Pre-releases:           v1.5.0-alpha.1 → v1.5.0-beta.1 → v1.5.0-rc.1
Current action run:     preparing v1.5.0 (full)
```

The action will:

1. Set the git baseline to `v1.4.0` (so every commit from the whole pre-release train is included).
2. Extract the changelog sections (or GitHub Release bodies) for  
   `v1.5.0-alpha.1`, `v1.5.0-beta.1`, `v1.5.0-rc.1`.
3. Give the LLM both those historical notes **and** the newest commits/PRs.
4. Ask it to produce one clean, de-duplicated Unreleased section suitable for the final stable release.

You can force the behaviour with:

```yaml
release-type: full
version: 1.5.0
```

or let `auto` decide from the version string / latest tag.

---

## Tips for frodo-cli / frodo-lib style projects

```yaml
- uses: your-username/ai-changelog-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    llm-api-key: ${{ secrets.OPENAI_API_KEY }}
    target-user-type: user
    user-focus: "CLI users"
    related-repos: "Frodo-org/frodo-lib"
    release-type: full          # when cutting the stable release
    version: ${{ github.event.release.tag_name }}
    prompt-extra: |
      Only include changes that a person running the frodo CLI would notice.
      When frodo-lib behaviour changes affect the CLI, call them out.
    commit: true
```

---

## Local testing

```bash
cd ai-changelog-action
npm install

export GITHUB_TOKEN=ghp_...
export LLM_API_KEY=sk-...
export GITHUB_REPOSITORY=owner/repo
export GITHUB_WORKSPACE=/path/to/your/repo
export DRY_RUN=true
export RELEASE_TYPE=full
export VERSION=1.5.0

node scripts/generate.js
```

Run unit tests locally:

```bash
npm test
```

## Built-in CI and self-release pipeline

This repository now includes two workflows:

- `.github/workflows/ci.yml`: runs unit tests on every push to `main` and every pull request.
- `.github/workflows/release.yml`: manual release pipeline that uses this action itself to update changelog content, promotes `Unreleased` into a versioned section, computes the next semver version from release type and current/latest version, tags it, and publishes a GitHub Release from that release section.

### Required secrets for release workflow

- `LLM_API_KEY`: your LLM provider key (OpenAI, Anthropic, etc.).

### Running a self-release

1. Open **Actions** in GitHub and run **Release**.
2. Choose `release-type`:
  - `prerelease` (default): creates or increments a prerelease version.
  - `patch`: creates a full patch release.
  - `minor`: creates a full minor release.
  - `major`: creates a full major release.
3. Optional: set `force-release=true` to allow releasing when there are no new commits since the last comparable release tag.
4. Optional: set `current-version` to override auto-detected latest tag.
5. Optional: set `prerelease-identifier` (default empty for numeric prereleases like `-1`, `-2`; can be `rc`, `beta`, `alpha`, etc.).
6. Optionally adjust `llm-provider`, `model`, `target-user-type`, and `user-focus`.
7. The workflow will test, compute next version, verify there are new commits since the last comparable release tag (unless forced), update changelog content, move `Unreleased` into `## [v<version>] - <date>`, create the corresponding `v<version>` tag, and publish the release using that section as the release body.
8. On non-prerelease releases, it also moves `v<major>` and `v<major>.<minor>` tags forward to the new release commit.

### Versioning behavior in release workflow

- If `release-type=prerelease` and latest/base is stable `x.y.z`, next version is `x.y.(z+1)-1` by default (or `x.y.(z+1)-<identifier>.1` when `prerelease-identifier` is set).
- If `release-type=prerelease` and latest/base is already numeric prerelease `x.y.z-n`, next version is `x.y.z-(n+1)`.
- If `release-type=prerelease` and latest/base is labeled prerelease `x.y.z-<label>.n`, next version is `x.y.z-<label>.(n+1)`.
- If `release-type=patch` and latest/base is prerelease `x.y.z-...`, next version is `x.y.z`.
- If `release-type=patch` and latest/base is stable `x.y.z`, next version is `x.y.(z+1)`.
- If `release-type=minor`, next version is `x.(y+1).0`.
- If `release-type=major`, next version is `(x+1).0.0`.
- If only a major action tag exists (for example `v1`) and no semver tag exists yet, the workflow bootstraps from `1.0.0`.
- If tags exist but none are semver-compatible, set `current-version` explicitly.

Release guard behavior:

- By default, the workflow aborts when there are no commits since the last comparable release tag.
- Set `force-release=true` to bypass this guard.

### Audience guidance without custom prompts

- Use `target-user-type: user` for CLI/tools/apps where notes should emphasize workflows, commands, flags, and practical usage impact.
- Use `target-user-type: developer` for libraries where notes should emphasize API changes, compatibility, and migration/integration impact.
- Use `user-focus` only when you want an explicit phrase override (for example `platform admins` or `SDK integrators`).

### Model guidance

Use any model your provider supports. Good defaults and tradeoffs for this action:

- `gpt-5` (OpenAI): strongest instruction-following and consolidation quality for large commit/PR context, especially helpful for full-release de-duplication.
- `gpt-4.1` (OpenAI): strong writing quality and reasoning with lower cost than top-tier models in many setups.
- `gpt-4o` (OpenAI): fast and cost-effective default for routine Unreleased updates.
- `claude-sonnet-4-20250514` (Anthropic): strong structured writing and summarization quality with good latency/cost balance.
- `claude-opus-4-20250514` (Anthropic): best for hardest consolidation/rewrite passes when changelog context is noisy or very large.

Practical recommendation for this action:

- Day-to-day runs: start with `gpt-4o` or `claude-sonnet-4-20250514`.
- Full/stable release consolidation runs: consider `gpt-5` or `claude-opus-4-20250514`.
- If output drifts from your style: keep model fixed and tune `target-user-type`, `user-focus`, and `prompt-extra` first.

---

## License

MIT
