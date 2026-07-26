#!/usr/bin/env node
/**
 * AI Changelog Updater – core logic
 *
 * Gathers git history, merged PRs, issues and optional related-repo activity,
 * then asks an LLM to produce a user-focused Unreleased section while
 * preserving any existing content under ## Unreleased.
 *
 * Special behaviour for full (stable) releases:
 *   When preparing a full release, the action also collects the changelog
 *   entries that were written for every pre-release (alpha/beta/rc/…) since
 *   the previous full release and feeds them to the LLM so it can produce a
 *   clean, consolidated set of notes.
 */

const core = require('@actions/core');
const github = require('@actions/github');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
      ...opts,
    }).trim();
  } catch (err) {
    return '';
  }
}

function runStrict(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    ...opts,
  }).trim();
}

/** Very small semver-ish pre-release detector */
function isPreRelease(tag) {
  if (!tag) return false;
  // Matches: -alpha, -beta, -rc, -pre, -next, -canary, -dev, +build, etc.
  return /-(alpha|beta|rc|pre|preview|next|canary|dev|snapshot)(\.|$|\d)/i.test(tag)
    || /\d+\.\d+\.\d+-.+/.test(tag); // any -suffix after the patch number
}

function getAllTags() {
  // Newest first
  const raw = run('git tag --sort=-creatordate');
  if (!raw) return [];
  return raw.split('\n').map((t) => t.trim()).filter(Boolean);
}

function getLastTag() {
  const tags = getAllTags();
  return tags[0] || null;
}

/** Last tag that is NOT a pre-release */
function getLastFullReleaseTag() {
  const tags = getAllTags();
  return tags.find((t) => !isPreRelease(t)) || null;
}

/**
 * All pre-release tags that appeared after the previous full release
 * (i.e. the ones that belong to the current release train).
 */
function getPreReleaseTagsSinceLastFull() {
  const tags = getAllTags();
  const result = [];
  for (const tag of tags) {
    if (!isPreRelease(tag)) break; // we hit the previous full release
    result.push(tag);
  }
  return result.reverse(); // chronological order
}

function getCommitsSince(ref) {
  if (!ref) {
    return run('git log --pretty=format:"%h %s (%an)" -n 150');
  }
  return run(`git log ${ref}..HEAD --pretty=format:"%h %s (%an)"`);
}

function getDiffStat(ref) {
  if (!ref) return '';
  return run(`git diff --stat ${ref}..HEAD`);
}

async function getMergedPRs(octokit, owner, repo, sinceDate) {
  const prs = [];
  try {
    const iterator = octokit.paginate.iterator(octokit.rest.pulls.list, {
      owner,
      repo,
      state: 'closed',
      sort: 'updated',
      direction: 'desc',
      per_page: 50,
    });

    for await (const response of iterator) {
      for (const pr of response.data) {
        if (!pr.merged_at) continue;
        if (sinceDate && new Date(pr.merged_at) < sinceDate) {
          return prs;
        }
        prs.push({
          number: pr.number,
          title: pr.title,
          body: (pr.body || '').slice(0, 1500),
          user: pr.user?.login,
          labels: (pr.labels || []).map((l) => l.name),
          merged_at: pr.merged_at,
          url: pr.html_url,
        });
        if (prs.length >= 50) return prs;
      }
    }
  } catch (err) {
    core.warning(`Failed to fetch PRs: ${err.message}`);
  }
  return prs;
}

async function getRelatedRepoActivity(octokit, relatedRepos, sinceDate) {
  const results = [];
  for (const full of relatedRepos) {
    const [owner, repo] = full.trim().split('/');
    if (!owner || !repo) continue;

    try {
      const commits = await octokit.rest.repos.listCommits({
        owner,
        repo,
        since: sinceDate ? sinceDate.toISOString() : undefined,
        per_page: 25,
      });
      const prs = await getMergedPRs(octokit, owner, repo, sinceDate);

      results.push({
        repo: full,
        commits: commits.data.map((c) => ({
          sha: c.sha.slice(0, 7),
          message: c.commit.message.split('\n')[0],
          author: c.commit.author?.name,
        })),
        prs: prs.slice(0, 15),
      });
    } catch (err) {
      core.warning(`Could not fetch activity for ${full}: ${err.message}`);
    }
  }
  return results;
}

/**
 * Extract every version section from CHANGELOG.md that matches the given tags.
 * Returns an array of { tag, body }.
 */
function extractChangelogSections(changelogContent, tags) {
  const sections = [];
  for (const tag of tags) {
    // Match ## [1.2.0-beta.1] or ## 1.2.0-beta.1 or ## v1.2.0-beta.1
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `^##?\\s*\\[?v?${escaped}\\]?.*?\\n([\\s\\S]*?)(?=^##?\\s+|(?![\\s\\S]))`,
      'im'
    );
    const match = changelogContent.match(re);
    if (match) {
      sections.push({ tag, body: match[1].trim() });
    }
  }
  return sections;
}

/**
 * Fallback: pull release bodies from GitHub Releases for the given tags.
 */
async function getGitHubReleaseBodies(octokit, owner, repo, tags) {
  const bodies = [];
  for (const tag of tags) {
    try {
      const { data } = await octokit.rest.repos.getReleaseByTag({ owner, repo, tag });
      if (data.body && data.body.trim()) {
        bodies.push({ tag, body: data.body.trim() });
      }
    } catch (_) {
      // release may not exist yet – ignore
    }
  }
  return bodies;
}

function extractUnreleased(content) {
  const match = content.match(/^##?\s+Unreleased\s*\n([\s\S]*?)(?=^##?\s+|(?![\s\S]))/im);
  if (match) {
    return {
      fullMatch: match[0],
      body: match[1].trim(),
      start: match.index,
      end: match.index + match[0].length,
    };
  }
  return null;
}

function buildPrompt({
  repo,
  userFocus,
  targetUserType,
  existingUnreleased,
  commits,
  diffStat,
  prs,
  related,
  preReleaseNotes,
  isFullRelease,
  version,
  promptExtra,
}) {
  const prBlock = prs
    .map(
      (p) =>
        `- #${p.number} ${p.title} (@${p.user}) [${(p.labels || []).join(', ')}]\n  ${p.body.slice(0, 400).replace(/\n/g, ' ')}`
    )
    .join('\n');

  const relatedBlock = related
    .map((r) => {
      const c = r.commits.map((c) => `  - ${c.sha} ${c.message}`).join('\n');
      const p = r.prs.map((p) => `  - #${p.number} ${p.title}`).join('\n');
      return `### ${r.repo}\nCommits:\n${c || '  (none)'}\nPRs:\n${p || '  (none)'}`;
    })
    .join('\n\n');

  let preReleaseBlock = '';
  if (preReleaseNotes.length) {
    preReleaseBlock = preReleaseNotes
      .map((n) => `### ${n.tag}\n${n.body}`)
      .join('\n\n');
  }

  const fullReleaseInstructions = isFullRelease
    ? `
IMPORTANT – THIS IS A FULL (STABLE) RELEASE${version ? ` (${version})` : ''}:
- You are also receiving the changelog entries that were written for every pre-release
  (alpha / beta / rc / …) since the previous full release.
- Consolidate all of those pre-release notes together with the newest changes into one
  clean, de-duplicated set of release notes.
- Remove pure pre-release-only remarks (e.g. “this is a beta”) but keep every user-visible
  change that landed during the pre-release cycle.
- The result should read as the final notes for the stable version.
`
    : '';

  const audienceInstructions = targetUserType === 'developer'
    ? 'Prioritize API changes, integration behavior, migration notes, compatibility details, and examples relevant to developers writing code against this project.'
    : 'Prioritize behavior, workflows, commands, flags, UX output, and practical usage impacts relevant to people using this project directly.';

  return `You are an expert technical writer maintaining a high-quality CHANGELOG.md.

Repository: ${repo}
Audience: ${userFocus}
${version ? `Version being prepared: ${version}` : ''}

TASK:
Update the **Unreleased** section of CHANGELOG.md with all relevant changes since the previous release.
Focus only on changes that matter to ${userFocus}. Ignore pure internal refactors, test-only changes, and dependency bumps that have no user-visible effect unless they fix a bug or change behaviour.
${audienceInstructions}
${fullReleaseInstructions}

RULES:
1. Keep the format user-focused and concise (Keep a Changelog style is preferred).
2. Preserve any pre-existing information that is already in the Unreleased section – merge intelligently, do not delete useful content.
3. Group changes under clear headings when appropriate (### Added, ### Changed, ### Fixed, ### Removed, etc.).
4. Reference PR numbers when useful (e.g. (#123)).
5. If a related library has changes that affect users of this project, mention them.
6. Output ONLY the new content that should appear under the "## Unreleased" heading. Do not include the heading itself. Do not wrap the answer in markdown code fences.

EXISTING UNRELEASED CONTENT (preserve / merge):
${existingUnreleased || '(empty)'}

${preReleaseNotes.length ? `CHANGELOG ENTRIES FROM PRE-RELEASES SINCE LAST FULL RELEASE:\n${preReleaseBlock}\n` : ''}

GIT COMMITS SINCE LAST RELEASE:
${commits || '(none)'}

DIFF STAT:
${diffStat || '(none)'}

MERGED PULL REQUESTS:
${prBlock || '(none)'}

RELATED REPOSITORIES ACTIVITY:
${relatedBlock || '(none)'}

${promptExtra ? `ADDITIONAL INSTRUCTIONS:\n${promptExtra}` : ''}

Now produce the updated Unreleased body:`;
}

async function callLLM({ provider, apiKey, model, prompt }) {
  if (provider === 'anthropic') {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0].text.trim();
  }

  // Default: OpenAI-compatible
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content:
          'You are a precise technical writer who produces clean, user-focused changelog entries.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
  });
  return completion.choices[0].message.content.trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const llmApiKey = process.env.LLM_API_KEY;
  const provider = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
  const model = process.env.MODEL || 'gpt-4o';
  const changelogPath = process.env.CHANGELOG_PATH || 'CHANGELOG.md';
  const sinceInput = process.env.SINCE || 'last-release';
  const relatedRepos = (process.env.RELATED_REPOS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const targetUserType = (process.env.TARGET_USER_TYPE || 'user').toLowerCase();
  const userFocus = process.env.USER_FOCUS
    || (targetUserType === 'developer'
      ? 'developers using this library in their own code'
      : 'people using this tool or application directly');
  const promptExtra = process.env.PROMPT_EXTRA || '';
  const dryRun = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';
  const shouldCommit = (process.env.COMMIT || 'false').toLowerCase() === 'true';
  const commitMessage = process.env.COMMIT_MESSAGE || 'docs: update CHANGELOG.md (Unreleased)';
  const releaseTypeInput = (process.env.RELEASE_TYPE || 'auto').toLowerCase();
  const version = process.env.VERSION || '';

  if (!['user', 'developer'].includes(targetUserType)) {
    core.setFailed('target-user-type must be one of: user, developer');
    return;
  }

  if (!['auto', 'full', 'prerelease'].includes(releaseTypeInput)) {
    core.setFailed('release-type must be one of: auto, full, prerelease');
    return;
  }

  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const fullChangelogPath = path.join(workspace, changelogPath);

  if (!token) {
    core.setFailed('github-token is required');
    return;
  }
  if (!llmApiKey) {
    core.setFailed('llm-api-key is required');
    return;
  }

  const octokit = github.getOctokit(token);

  // ------------------------------------------------------------------
  // 1. Determine baseline & whether this is a full release
  // ------------------------------------------------------------------
  const lastFullTag = getLastFullReleaseTag();
  const lastTag = getLastTag();
  const preReleaseTags = getPreReleaseTagsSinceLastFull();

  let isFullRelease = false;
  if (releaseTypeInput === 'full') {
    isFullRelease = true;
  } else if (releaseTypeInput === 'prerelease') {
    isFullRelease = false;
  } else {
    // auto: treat as full release when the user is not currently on a pre-release tag
    // or when they explicitly pass a stable-looking version
    isFullRelease = version ? !isPreRelease(version) : !isPreRelease(lastTag);
  }

  core.info(`Last full release tag : ${lastFullTag || '(none)'}`);
  core.info(`Latest tag            : ${lastTag || '(none)'}`);
  core.info(`Pre-release tags      : ${preReleaseTags.join(', ') || '(none)'}`);
  core.info(`Treating as full release: ${isFullRelease}`);

  // Baseline for "what changed"
  let sinceRef = sinceInput;
  if (sinceInput === 'last-release') {
    // For a full release we go all the way back to the previous full release
    // so that every commit that landed during the pre-release cycle is included.
    sinceRef = isFullRelease ? lastFullTag : lastTag;
    core.info(`Using baseline ref: ${sinceRef || '(no tags – using full history)'}`);
  }

  let sinceDate = null;
  if (sinceRef) {
    const dateStr = run(`git log -1 --format=%cI ${sinceRef}`);
    if (dateStr) sinceDate = new Date(dateStr);
  }

  // ------------------------------------------------------------------
  // 2. Collect data
  // ------------------------------------------------------------------
  core.info('Collecting commits and diff…');
  const commits = getCommitsSince(sinceRef);
  const diffStat = getDiffStat(sinceRef);

  core.info('Fetching merged pull requests…');
  const prs = await getMergedPRs(octokit, owner, repo, sinceDate);

  let related = [];
  if (relatedRepos.length) {
    core.info(`Fetching activity from related repos: ${relatedRepos.join(', ')}`);
    related = await getRelatedRepoActivity(octokit, relatedRepos, sinceDate);
  }

  // ------------------------------------------------------------------
  // 3. Read existing CHANGELOG
  // ------------------------------------------------------------------
  let changelogContent = '';
  if (fs.existsSync(fullChangelogPath)) {
    changelogContent = fs.readFileSync(fullChangelogPath, 'utf8');
  } else {
    core.info(`${changelogPath} does not exist yet – will create it.`);
    changelogContent = '# Changelog\n\n## Unreleased\n\n';
  }

  const unreleased = extractUnreleased(changelogContent);
  const existingBody = unreleased ? unreleased.body : '';

  // ------------------------------------------------------------------
  // 4. When this is a full release, gather pre-release changelog notes
  // ------------------------------------------------------------------
  let preReleaseNotes = [];
  if (isFullRelease && preReleaseTags.length) {
    core.info('Collecting changelog entries from pre-releases…');

    // Prefer sections already written in CHANGELOG.md
    preReleaseNotes = extractChangelogSections(changelogContent, preReleaseTags);

    // Fallback / complement: GitHub Release bodies
    if (preReleaseNotes.length < preReleaseTags.length) {
      const missing = preReleaseTags.filter(
        (t) => !preReleaseNotes.some((n) => n.tag === t)
      );
      if (missing.length) {
        core.info(`Fetching GitHub Release bodies for: ${missing.join(', ')}`);
        const fromGitHub = await getGitHubReleaseBodies(octokit, owner, repo, missing);
        preReleaseNotes = preReleaseNotes.concat(fromGitHub);
      }
    }

    core.info(`Found pre-release notes for: ${preReleaseNotes.map((n) => n.tag).join(', ') || '(none)'}`);
  }

  // ------------------------------------------------------------------
  // 5. Build prompt & call LLM
  // ------------------------------------------------------------------
  core.info(`Calling ${provider} (${model})…`);
  const prompt = buildPrompt({
    repo: process.env.GITHUB_REPOSITORY,
    userFocus,
    targetUserType,
    existingUnreleased: existingBody,
    commits,
    diffStat,
    prs,
    related,
    preReleaseNotes,
    isFullRelease,
    version,
    promptExtra,
  });

  let newBody;
  try {
    newBody = await callLLM({ provider, apiKey: llmApiKey, model, prompt });
  } catch (err) {
    core.setFailed(`LLM call failed: ${err.message}`);
    return;
  }

  // Clean possible accidental fences
  newBody = newBody
    .replace(/^```(?:markdown)?\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();

  core.info('--- Generated Unreleased content ---');
  core.info(newBody);
  core.info('------------------------------------');

  core.setOutput('unreleased-content', newBody);
  core.setOutput('is-full-release', String(isFullRelease));
  core.setOutput('pre-release-tags', preReleaseTags.join(','));

  if (dryRun) {
    core.info('dry-run=true → not writing file');
    core.setOutput('changelog-updated', 'false');
    return;
  }

  // ------------------------------------------------------------------
  // 6. Write updated CHANGELOG
  // ------------------------------------------------------------------
  let updated;
  if (unreleased) {
    const before = changelogContent.slice(0, unreleased.start);
    const after = changelogContent.slice(unreleased.end);
    updated = `${before}## Unreleased\n\n${newBody}\n\n${after}`.replace(/\n{3,}/g, '\n\n');
  } else {
    const lines = changelogContent.split('\n');
    const insertAt = lines.findIndex((l) => l.startsWith('# ')) + 1 || 0;
    lines.splice(insertAt, 0, '', '## Unreleased', '', newBody, '');
    updated = lines.join('\n');
  }

  if (updated === changelogContent) {
    core.info(`No changes in ${changelogPath}`);
    core.setOutput('changelog-updated', 'false');
  } else {
    fs.writeFileSync(fullChangelogPath, updated, 'utf8');
    core.info(`Updated ${changelogPath}`);
    core.setOutput('changelog-updated', 'true');
  }

  // ------------------------------------------------------------------
  // 7. Optional commit
  // ------------------------------------------------------------------
  if (shouldCommit) {
    runStrict('git config user.name "github-actions[bot]"');
    runStrict('git config user.email "github-actions[bot]@users.noreply.github.com"');
    runStrict(`git add "${changelogPath}"`);
    const status = run('git status --porcelain');
    if (status) {
      runStrict(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`);
      runStrict('git push');
      core.info('Committed and pushed CHANGELOG update');
    } else {
      core.info('No changes to commit');
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    core.setFailed(err.message);
    console.error(err);
  });
}

module.exports = {
  isPreRelease,
  extractUnreleased,
  extractChangelogSections,
  buildPrompt,
};
