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

function isStableSemverTag(tag) {
  if (!tag) return false;
  return /^v?\d+\.\d+\.\d+$/.test(tag);
}

function normalizeGeneratedBody(body) {
  if (!body) return '';
  const lines = body.split('\n');

  while (lines.length && !lines[0].trim()) {
    lines.shift();
  }

  // LLMs occasionally return a heading even though we ask for body-only output.
  // Remove a single leading heading so the content remains valid under Unreleased.
  if (lines.length && /^#{1,2}\s+/.test(lines[0])) {
    lines.shift();
    while (lines.length && !lines[0].trim()) {
      lines.shift();
    }
  }

  return lines.join('\n').trim();
}

function normalizeComparableLine(line) {
  return line
    .replace(/`[^`]+`/g, '')
    .replace(/\((?:commit\s+)?[0-9a-f]{7,}\)/ig, '')
    .replace(/\(#\d+\)/g, '')
    .replace(/#([0-9]+)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:;!,]+$/g, '')
    .toLowerCase();
}

function getBulletLines(body) {
  if (!body) return [];
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line));
}

function removeDuplicateReleaseLines(body, previousReleaseBody) {
  if (!body || !previousReleaseBody) return body;

  const previousBulletSet = new Set(
    getBulletLines(previousReleaseBody)
      .map((line) => normalizeComparableLine(line))
      .filter(Boolean)
  );

  if (!previousBulletSet.size) return body;

  const lines = body.split('\n');
  const filtered = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^###\s+.+\(from pre-releases\)\s*$/i.test(trimmed)) {
      continue;
    }

    if (/^-\s+/.test(trimmed)) {
      const normalized = normalizeComparableLine(trimmed);
      if (normalized && previousBulletSet.has(normalized)) {
        continue;
      }
    }

    filtered.push(line);
  }

  const compacted = [];
  for (let index = 0; index < filtered.length; index += 1) {
    const line = filtered[index];
    const trimmed = line.trim();

    if (/^###\s+/.test(trimmed)) {
      let hasBullet = false;
      for (let lookahead = index + 1; lookahead < filtered.length; lookahead += 1) {
        const nextTrimmed = filtered[lookahead].trim();
        if (/^###\s+/.test(nextTrimmed)) break;
        if (/^-\s+/.test(nextTrimmed)) {
          hasBullet = true;
          break;
        }
      }
      if (!hasBullet) {
        continue;
      }
    }

    if (trimmed === '' && compacted[compacted.length - 1] === '') {
      continue;
    }

    compacted.push(line);
  }

  return compacted.join('\n').trim();
}

function hasRelatedActivity(related) {
  return related.some((entry) => (entry.commits && entry.commits.length) || (entry.prs && entry.prs.length));
}

function hasMeaningfulReleaseInput({ commits, diffStat, prs, related, preReleaseNotes, existingBody }) {
  return Boolean(
    (commits && commits.trim())
    || (diffStat && diffStat.trim())
    || (prs && prs.length)
    || hasRelatedActivity(related || [])
    || (preReleaseNotes && preReleaseNotes.length)
    || (existingBody && existingBody.trim())
  );
}

function getChangedFilesSince(ref) {
  const raw = ref
    ? run(`git diff --name-only ${ref}..HEAD`)
    : run('git show --pretty="" --name-only HEAD');
  if (!raw) return [];
  return raw.split('\n').map((line) => line.trim()).filter(Boolean);
}

function isFunctionalActionPath(filePath) {
  return filePath === 'action.yml'
    || filePath === 'package.json'
    || filePath.startsWith('scripts/')
    || filePath.startsWith('src/')
    || filePath.startsWith('dist/')
    || filePath.startsWith('lib/')
    || filePath === 'index.js'
    || filePath === 'index.mjs'
    || filePath === 'main.js'
    || filePath === 'main.mjs';
}

function classifyReleaseFallback({ changedFiles, existingBody, preReleaseNotes }) {
  if (existingBody && existingBody.trim()) {
    return null;
  }

  if (preReleaseNotes && preReleaseNotes.length) {
    return null;
  }

  if (!changedFiles.length) {
    return 'cosmetic-release';
  }

  if (changedFiles.every((filePath) => filePath.startsWith('.github/'))) {
    return 'pipeline-only';
  }

  if (!changedFiles.some((filePath) => isFunctionalActionPath(filePath))) {
    return 'internal-only';
  }

  return null;
}

function buildFallbackReleaseNotes(kind) {
  switch (kind) {
    case 'pipeline-only':
      return [
        '### Changed',
        '- Internal pipeline update release. This release updates CI/CD or release automation under `.github/` without changing functional behavior.',
      ].join('\n');
    case 'internal-only':
      return [
        '### Changed',
        '- Internal changes only. This release does not introduce functional behavior changes.',
      ].join('\n');
    case 'cosmetic-release':
      return [
        '### Changed',
        '- Cosmetic version update release. This release records a version or release-state change without additional functional behavior changes.',
      ].join('\n');
    default:
      return '';
  }
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
  const stable = tags.find((t) => isStableSemverTag(t) && !isPreRelease(t));
  if (stable) return stable;
  return tags.find((t) => !isPreRelease(t)) || null;
}

/**
 * All pre-release tags that appeared after the previous full release
 * (i.e. the ones that belong to the current release train).
 */
function getPreReleaseTagsSinceLastFullFromTags(tags) {
  const result = [];
  for (const tag of tags) {
    if (!isStableSemverTag(tag) && !isPreRelease(tag)) {
      continue; // ignore moving major/minor aliases like v1, v1.0
    }
    if (isStableSemverTag(tag) && !isPreRelease(tag)) break; // we hit the previous stable full release
    result.push(tag);
  }
  return result.reverse(); // chronological order
}

function getPreReleaseTagsSinceLastFull() {
  return getPreReleaseTagsSinceLastFullFromTags(getAllTags());
}

function getCommitsSince(ref) {
  if (!ref) {
    return run('git log --pretty=format:"%h %s (%an)" -n 150');
  }
  return run(`git log ${ref}..HEAD --pretty=format:"%h %s (%an)"`);
}

function getCommitEntriesSince(ref) {
  const raw = ref
    ? run(`git log ${ref}..HEAD --pretty=format:"%h%x09%s%x09%an"`)
    : run('git log --pretty=format:"%h%x09%s%x09%an" -n 150');
  if (!raw) return [];

  return raw
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 2)
    .map(([sha, subject, author]) => ({
      sha: sha.trim(),
      subject: (subject || '').trim(),
      author: (author || '').trim(),
    }))
    .filter((entry) => entry.sha && entry.subject);
}

function toSentence(text) {
  if (!text) return '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  const normalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function normalizeCommitSubject(subject) {
  const cleaned = subject.replace(/^[a-z]+(\([^)]+\))?!?:\s*/i, '').trim();
  return toSentence(cleaned || subject);
}

function buildDeterministicCommitNotes(commitEntries) {
  const bullets = commitEntries.map((entry) => `- ${normalizeCommitSubject(entry.subject)} (commit ${entry.sha})`);
  if (!bullets.length) return '';
  return ['### Changed', ...bullets].join('\n');
}

function isBulletGrounded(line, { allowedCommits, allowedPRs }) {
  const commitMatches = line.match(/\b[0-9a-f]{7,40}\b/ig) || [];
  if (commitMatches.some((value) => allowedCommits.has(value.toLowerCase()))) {
    return true;
  }

  const prMatches = [...line.matchAll(/#(\d+)/g)].map((match) => match[1]);
  if (prMatches.some((value) => allowedPRs.has(value))) {
    return true;
  }

  return false;
}

function filterGroundedReleaseNotes(body, { commitEntries, prs }) {
  if (!body) return '';

  const allowedCommits = new Set(
    (commitEntries || []).flatMap((entry) => {
      const values = [entry.sha.toLowerCase()];
      if (entry.sha.length > 7) {
        values.push(entry.sha.slice(0, 7).toLowerCase());
      }
      return values;
    })
  );
  const allowedPRs = new Set((prs || []).map((pr) => String(pr.number)));

  const lines = body.split('\n');
  const filtered = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^###\s+/.test(trimmed) || trimmed === '') {
      filtered.push(line);
      continue;
    }

    if (/^-\s+/.test(trimmed) && isBulletGrounded(trimmed, { allowedCommits, allowedPRs })) {
      filtered.push(line);
    }
  }

  const compacted = [];
  for (let index = 0; index < filtered.length; index += 1) {
    const line = filtered[index];
    const trimmed = line.trim();

    if (/^###\s+/.test(trimmed)) {
      let hasBullet = false;
      for (let lookahead = index + 1; lookahead < filtered.length; lookahead += 1) {
        const nextTrimmed = filtered[lookahead].trim();
        if (/^###\s+/.test(nextTrimmed)) break;
        if (/^-\s+/.test(nextTrimmed)) {
          hasBullet = true;
          break;
        }
      }
      if (!hasBullet) {
        continue;
      }
    }

    if (trimmed === '' && compacted[compacted.length - 1] === '') {
      continue;
    }

    compacted.push(line);
  }

  return compacted.join('\n').trim();
}

function mergePreservingExistingUnreleased(existingBody, generatedBody) {
  const preserved = (existingBody || '').trim();
  const generated = (generatedBody || '').trim();

  if (!preserved) return generated;
  if (!generated) return preserved;
  if (generated === preserved) return preserved;

  const preservedLines = preserved.split('\n').map((line) => line.trim());
  const preservedLineSet = new Set(preservedLines.filter(Boolean));

  const generatedLines = generated.split('\n');
  const additionalLines = [];
  for (const line of generatedLines) {
    const trimmed = line.trim();
    if (trimmed && preservedLineSet.has(trimmed)) {
      continue;
    }
    additionalLines.push(line);
  }

  const additional = additionalLines.join('\n').trim();
  if (!additional) return preserved;

  return `${preserved}\n\n${additional}`.replace(/\n{3,}/g, '\n\n').trim();
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

function formatReleaseHeading(tag, date) {
  return `## [${tag}] - ${date}`;
}

function toUtcDateString() {
  return new Date().toISOString().slice(0, 10);
}

function upsertUnreleased(content, body) {
  const unreleased = extractUnreleased(content);
  if (unreleased) {
    const before = content.slice(0, unreleased.start);
    const after = content.slice(unreleased.end);
    return `${before}## Unreleased\n\n${body}\n\n${after}`.replace(/\n{3,}/g, '\n\n');
  }

  const lines = content.split('\n');
  const insertAt = lines.findIndex((l) => l.startsWith('# ')) + 1 || 0;
  lines.splice(insertAt, 0, '', '## Unreleased', '', body, '');
  return lines.join('\n');
}

function promoteUnreleased(content, { tag, date, failIfEmpty }) {
  const unreleased = extractUnreleased(content);
  if (!unreleased) {
    throw new Error('Could not find Unreleased section for promotion');
  }

  const notes = unreleased.body.trim();
  if (!notes && failIfEmpty) {
    throw new Error('No changelog content under Unreleased');
  }

  const heading = formatReleaseHeading(tag, date);
  if (content.includes(heading)) {
    return {
      updatedContent: content,
      notes,
      heading,
      promoted: false,
      headingExists: true,
    };
  }

  const replacement = `## Unreleased\n\n${heading}\n\n${notes}\n\n`;
  const updatedContent = content.replace(unreleased.fullMatch, replacement).replace(/\n{3,}/g, '\n\n');

  return {
    updatedContent,
    notes,
    heading,
    promoted: true,
    headingExists: false,
  };
}

function buildPrompt({
  repo,
  userFocus,
  targetUserType,
  existingUnreleased,
  previousReleaseBody,
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

  const previousReleaseBlock = previousReleaseBody
    ? `PREVIOUS RELEASE NOTES (do not restate these items unless the current changes materially extend or change them):\n${previousReleaseBody}\n`
    : '';

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
6. Do NOT restate capabilities that were already described in the most recent release unless the current commit range materially changes or extends them.
7. Every bullet MUST end with evidence from the current release range, using either \`(#123)\` for a current PR or \`(commit abc1234)\` for a current commit.
8. Output ONLY the new content that should appear under the "## Unreleased" heading. Do not include the heading itself. Do not wrap the answer in markdown code fences.

EXISTING UNRELEASED CONTENT (preserve / merge):
${existingUnreleased || '(empty)'}

${previousReleaseBlock}

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
  const promoteRelease = (process.env.PROMOTE_RELEASE || 'false').toLowerCase() === 'true';
  const releaseTag = process.env.RELEASE_TAG || '';
  const releaseDate = process.env.RELEASE_DATE || '';
  const releaseNotesPath = process.env.RELEASE_NOTES_PATH || 'RELEASE_NOTES.md';
  const failIfEmptyReleaseNotes = (process.env.FAIL_IF_EMPTY_RELEASE_NOTES || 'true').toLowerCase() === 'true';

  if (!['user', 'developer'].includes(targetUserType)) {
    core.setFailed('target-user-type must be one of: user, developer');
    return;
  }

  if (!['auto', 'full', 'prerelease'].includes(releaseTypeInput)) {
    core.setFailed('release-type must be one of: auto, full, prerelease');
    return;
  }

  if (promoteRelease && !releaseTag) {
    core.setFailed('release-tag is required when promote-release=true');
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
  const commitEntries = getCommitEntriesSince(sinceRef);
  const commits = getCommitsSince(sinceRef);
  const diffStat = getDiffStat(sinceRef);
  const changedFiles = getChangedFilesSince(sinceRef);

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
  const previousReleaseNotes = sinceRef
    ? extractChangelogSections(changelogContent, [sinceRef])[0]?.body || ''
    : '';

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
  const fallbackKind = classifyReleaseFallback({
    changedFiles,
    existingBody,
    preReleaseNotes,
  });

  if (fallbackKind) {
    core.info(`Using deterministic fallback release notes (${fallbackKind})`);
  }

  if (promoteRelease && !fallbackKind && !hasMeaningfulReleaseInput({
    commits,
    diffStat,
    prs,
    related,
    preReleaseNotes,
    existingBody,
  })) {
    core.setFailed(`No release changes detected since ${sinceRef || 'repository start'}`);
    return;
  }

  let newBody;
  if (fallbackKind) {
    newBody = buildFallbackReleaseNotes(fallbackKind);
  } else {
    core.info(`Calling ${provider} (${model})…`);
    const prompt = buildPrompt({
      repo: process.env.GITHUB_REPOSITORY,
      userFocus,
      targetUserType,
      existingUnreleased: existingBody,
      previousReleaseBody: previousReleaseNotes,
      commits,
      diffStat,
      prs,
      related,
      preReleaseNotes,
      isFullRelease,
      version,
      promptExtra,
    });

    try {
      newBody = await callLLM({ provider, apiKey: llmApiKey, model, prompt });
    } catch (err) {
      core.setFailed(`LLM call failed: ${err.message}`);
      return;
    }
  }

  // Clean possible accidental fences
  newBody = newBody
    .replace(/^```(?:markdown)?\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();
  newBody = normalizeGeneratedBody(newBody);
  if (!fallbackKind && !preReleaseNotes.length) {
    newBody = removeDuplicateReleaseLines(newBody, previousReleaseNotes);
  }
  if (!fallbackKind) {
    newBody = filterGroundedReleaseNotes(newBody, {
      commitEntries,
      prs,
    });
    if (!newBody) {
      newBody = buildDeterministicCommitNotes(commitEntries);
    }

    // Preserve pre-existing Unreleased entries verbatim, even if generated
    // content was de-duplicated or filtered by grounding rules.
    newBody = mergePreservingExistingUnreleased(existingBody, newBody);
  }

  core.info('--- Generated Unreleased content ---');
  core.info(newBody);
  core.info('------------------------------------');

  core.setOutput('unreleased-content', newBody);
  core.setOutput('is-full-release', String(isFullRelease));
  core.setOutput('pre-release-tags', preReleaseTags.join(','));
  core.setOutput('release-notes', newBody);
  core.setOutput('release-heading', '');
  core.setOutput('promoted', 'false');

  if (dryRun) {
    core.info('dry-run=true → not writing file');
    core.setOutput('changelog-updated', 'false');
    return;
  }

  // ------------------------------------------------------------------
  // 6. Write updated CHANGELOG
  // ------------------------------------------------------------------
  const unreleasedUpdated = upsertUnreleased(changelogContent, newBody);
  let updated = unreleasedUpdated;

  if (promoteRelease) {
    const date = releaseDate || toUtcDateString();
    const promotion = promoteUnreleased(unreleasedUpdated, {
      tag: releaseTag,
      date,
      failIfEmpty: failIfEmptyReleaseNotes,
    });

    updated = promotion.updatedContent;
    core.setOutput('release-notes', promotion.notes);
    core.setOutput('release-heading', promotion.heading);
    core.setOutput('promoted', String(promotion.promoted));

    const releaseNotesAbsolute = path.join(workspace, releaseNotesPath);
    fs.writeFileSync(releaseNotesAbsolute, `${promotion.notes}\n`, 'utf8');
    core.info(`Wrote release notes to ${releaseNotesPath}`);

    if (promotion.headingExists) {
      core.info(`Release heading already present (${promotion.heading}); skipping duplicate promotion`);
    }
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
    if (promoteRelease) {
      runStrict(`git add "${releaseNotesPath}"`);
    }
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
  isStableSemverTag,
  normalizeGeneratedBody,
  removeDuplicateReleaseLines,
  hasMeaningfulReleaseInput,
  getChangedFilesSince,
  getCommitEntriesSince,
  buildDeterministicCommitNotes,
  isFunctionalActionPath,
  filterGroundedReleaseNotes,
  mergePreservingExistingUnreleased,
  getPreReleaseTagsSinceLastFullFromTags,
  classifyReleaseFallback,
  buildFallbackReleaseNotes,
  extractUnreleased,
  extractChangelogSections,
  formatReleaseHeading,
  upsertUnreleased,
  promoteUnreleased,
  buildPrompt,
};
