const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPreRelease,
  isStableSemverTag,
  normalizeGeneratedBody,
  removeDuplicateReleaseLines,
  hasMeaningfulReleaseInput,
  buildDeterministicCommitNotes,
  isFunctionalActionPath,
  filterGroundedReleaseNotes,
  mergePreservingExistingUnreleased,
  classifyReleaseFallback,
  buildFallbackReleaseNotes,
  extractUnreleased,
  extractChangelogSections,
  getPreReleaseTagsSinceLastFullFromTags,
  formatReleaseHeading,
  upsertUnreleased,
  promoteUnreleased,
  buildPrompt,
} = require('../scripts/generate');

test('isPreRelease detects stable and pre-release versions', () => {
  assert.equal(isPreRelease('1.2.3'), false);
  assert.equal(isPreRelease('1.2.3-beta.1'), true);
  assert.equal(isPreRelease('v2.0.0-rc1'), true);
  assert.equal(isPreRelease('4.1.2-1'), true);
});

test('isStableSemverTag detects full stable semver tags only', () => {
  assert.equal(isStableSemverTag('v2'), false);
  assert.equal(isStableSemverTag('v2.0'), false);
  assert.equal(isStableSemverTag('v2.0.0'), true);
  assert.equal(isStableSemverTag('2.1.3'), true);
  assert.equal(isStableSemverTag('v1.0.8-1'), false);
});

test('normalizeGeneratedBody strips accidental heading from LLM output', () => {
  const raw = [
    '## 2.0.0',
    '',
    '### Added',
    '- Important change',
    '',
  ].join('\n');

  const normalized = normalizeGeneratedBody(raw);
  assert.equal(normalized, '### Added\n- Important change');
});

test('hasMeaningfulReleaseInput is false when there are no changes to release', () => {
  assert.equal(
    hasMeaningfulReleaseInput({
      commits: '',
      diffStat: '',
      prs: [],
      related: [],
      preReleaseNotes: [],
      existingBody: '',
    }),
    false
  );

  assert.equal(
    hasMeaningfulReleaseInput({
      commits: 'abc123 fix release logic',
      diffStat: '',
      prs: [],
      related: [],
      preReleaseNotes: [],
      existingBody: '',
    }),
    true
  );
});

test('isFunctionalActionPath distinguishes functional code from pipeline-only files', () => {
  assert.equal(isFunctionalActionPath('.github/workflows/release.yml'), false);
  assert.equal(isFunctionalActionPath('scripts/generate.js'), true);
  assert.equal(isFunctionalActionPath('action.yml'), true);
  assert.equal(isFunctionalActionPath('README.md'), false);
});

test('classifyReleaseFallback detects cosmetic, pipeline-only, and internal-only releases', () => {
  assert.equal(
    classifyReleaseFallback({
      changedFiles: [],
      existingBody: '',
      preReleaseNotes: [],
    }),
    'cosmetic-release'
  );

  assert.equal(
    classifyReleaseFallback({
      changedFiles: ['.github/workflows/release.yml', '.github/workflows/ci.yml'],
      existingBody: '',
      preReleaseNotes: [],
    }),
    'pipeline-only'
  );

  assert.equal(
    classifyReleaseFallback({
      changedFiles: ['README.md', 'docs/notes.md'],
      existingBody: '',
      preReleaseNotes: [],
    }),
    'internal-only'
  );

  assert.equal(
    classifyReleaseFallback({
      changedFiles: ['scripts/generate.js'],
      existingBody: '',
      preReleaseNotes: [],
    }),
    null
  );
});

test('buildFallbackReleaseNotes returns deterministic internal release notes', () => {
  assert.match(buildFallbackReleaseNotes('pipeline-only'), /pipeline update release|Internal pipeline update release/i);
  assert.match(buildFallbackReleaseNotes('internal-only'), /Internal changes only/);
  assert.match(buildFallbackReleaseNotes('cosmetic-release'), /Cosmetic version update release/);
});

test('pipeline-only fallback notes are preserved even when identical to previous release notes', () => {
  const fallback = buildFallbackReleaseNotes('pipeline-only');
  const deduped = removeDuplicateReleaseLines(fallback, fallback);

  assert.equal(deduped, '');
  assert.match(fallback, /pipeline update release|Internal pipeline update release/i);
});

test('removeDuplicateReleaseLines removes bullets already present in previous release notes', () => {
  const current = [
    '### Added',
    '- Existing capability from previous release. (#27)',
    '- Truly new capability. (commit abcdef1)',
  ].join('\n');

  const previous = [
    '### Added',
    '- Existing capability from previous release.',
  ].join('\n');

  const deduped = removeDuplicateReleaseLines(current, previous);
  assert.doesNotMatch(deduped, /Existing capability from previous release/);
  assert.match(deduped, /Truly new capability/);
});

test('removeDuplicateReleaseLines strips empty from pre-releases headings when not applicable', () => {
  const current = [
    '### Added',
    '- Truly new capability.',
    '',
    '### Added (from pre-releases)',
    '- Existing capability from previous release.',
  ].join('\n');

  const previous = [
    '### Added',
    '- Existing capability from previous release.',
  ].join('\n');

  const deduped = removeDuplicateReleaseLines(current, previous);
  assert.doesNotMatch(deduped, /from pre-releases/);
  assert.match(deduped, /Truly new capability/);
});

test('filterGroundedReleaseNotes keeps only bullets tied to current commit or PR evidence', () => {
  const body = [
    '### Added',
    '- Old repeated capability. (commit 49efe6f)',
    '- New grounded capability. (commit e7ec998)',
    '- Also grounded by PR. (#42)',
  ].join('\n');

  const filtered = filterGroundedReleaseNotes(body, {
    commitEntries: [{ sha: 'e7ec998', subject: 'feat: grounded change', author: 'test' }],
    prs: [{ number: 42 }],
  });

  assert.doesNotMatch(filtered, /49efe6f/);
  assert.match(filtered, /e7ec998/);
  assert.match(filtered, /#42/);
});

test('mergePreservingExistingUnreleased keeps existing content verbatim when generated body is empty', () => {
  const existing = [
    '### Changed',
    '- Manual note without commit evidence.',
  ].join('\n');

  const merged = mergePreservingExistingUnreleased(existing, '');
  assert.equal(merged, existing);
});

test('mergePreservingExistingUnreleased keeps existing content and appends new generated lines', () => {
  const existing = [
    '### Changed',
    '- Manual note without commit evidence.',
  ].join('\n');

  const generated = [
    '### Changed',
    '- Manual note without commit evidence.',
    '- New grounded capability. (commit e7ec998)',
  ].join('\n');

  const merged = mergePreservingExistingUnreleased(existing, generated);
  assert.match(merged, /Manual note without commit evidence\./);
  assert.match(merged, /New grounded capability\. \(commit e7ec998\)/);
});

test('buildDeterministicCommitNotes creates commit-grounded fallback notes', () => {
  const notes = buildDeterministicCommitNotes([
    { sha: 'abc1234', subject: 'feat: add grounded fallback', author: 'test' },
    { sha: 'def5678', subject: 'fix: improve release filtering', author: 'test' },
  ]);

  assert.match(notes, /^### Changed/m);
  assert.match(notes, /Add grounded fallback\. \(commit abc1234\)/);
  assert.match(notes, /Improve release filtering\. \(commit def5678\)/);
});

test('extractUnreleased returns section boundaries and body', () => {
  const changelog = [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    '### Added',
    '- New command',
    '',
    '## 1.0.0',
    '- Initial release',
    '',
  ].join('\n');

  const unreleased = extractUnreleased(changelog);
  assert.ok(unreleased);
  assert.equal(unreleased.body, '### Added\n- New command');
  assert.ok(unreleased.start >= 0);
  assert.ok(unreleased.end > unreleased.start);
});

test('extractChangelogSections finds matching tagged sections', () => {
  const changelog = [
    '# Changelog',
    '',
    '## v1.1.0-beta.1',
    '',
    '- Beta change',
    '',
    '## [1.1.0-beta.2]',
    '',
    '- More beta changes',
    '',
  ].join('\n');

  const sections = extractChangelogSections(changelog, ['1.1.0-beta.1', '1.1.0-beta.2']);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].tag, '1.1.0-beta.1');
  assert.match(sections[0].body, /Beta change/);
  assert.equal(sections[1].tag, '1.1.0-beta.2');
  assert.match(sections[1].body, /More beta changes/);
});

test('getPreReleaseTagsSinceLastFull ignores major/minor alias tags', () => {
  const tags = getPreReleaseTagsSinceLastFullFromTags(['v1', 'v1.0', 'v1.0.6-1', 'v1.0.6']);
  assert.deepEqual(tags, ['v1.0.6-1']);
});

test('buildPrompt includes audience-specific guidance', () => {
  const baseParams = {
    repo: 'vscheuber/ai-changelog-action',
    userFocus: 'library consumers',
    existingUnreleased: '',
    previousReleaseBody: '### Added\n- Existing capability',
    commits: '',
    diffStat: '',
    prs: [],
    related: [],
    preReleaseNotes: [],
    isFullRelease: false,
    version: '',
    promptExtra: '',
  };

  const developerPrompt = buildPrompt({
    ...baseParams,
    targetUserType: 'developer',
  });

  const userPrompt = buildPrompt({
    ...baseParams,
    targetUserType: 'user',
  });

  assert.match(developerPrompt, /Prioritize API changes, integration behavior/);
  assert.match(userPrompt, /Prioritize behavior, workflows, commands, flags/);
  assert.match(userPrompt, /PREVIOUS RELEASE NOTES/);
  assert.match(userPrompt, /Do NOT restate capabilities that were already described/);
});

test('upsertUnreleased updates existing Unreleased section', () => {
  const changelog = [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    '- Old content',
    '',
    '## [v1.0.0] - 2026-01-01',
    '',
    '- Initial',
    '',
  ].join('\n');

  const updated = upsertUnreleased(changelog, '### Added\n- New content');
  assert.match(updated, /## Unreleased\n\n### Added\n- New content/);
  assert.doesNotMatch(updated, /Old content/);
});

test('promoteUnreleased inserts versioned heading and resets Unreleased', () => {
  const changelog = [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    '### Added',
    '- New command',
    '',
    '## [v1.0.0] - 2026-01-01',
    '',
    '- Initial release',
    '',
  ].join('\n');

  const promoted = promoteUnreleased(changelog, {
    tag: 'v1.0.1',
    date: '2026-08-01',
    failIfEmpty: true,
  });

  assert.equal(promoted.promoted, true);
  assert.equal(promoted.heading, formatReleaseHeading('v1.0.1', '2026-08-01'));
  assert.equal(promoted.notes, '### Added\n- New command');
  assert.match(promoted.updatedContent, /## Unreleased\n\n## \[v1.0.1\] - 2026-08-01\n\n### Added\n- New command/);
});

test('promoteUnreleased is rerun-safe when heading already exists', () => {
  const changelog = [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    '## [v1.0.1] - 2026-08-01',
    '',
    '### Added',
    '- New command',
    '',
  ].join('\n');

  const promoted = promoteUnreleased(changelog, {
    tag: 'v1.0.1',
    date: '2026-08-01',
    failIfEmpty: false,
  });

  assert.equal(promoted.promoted, false);
  assert.equal(promoted.headingExists, true);
  assert.equal(promoted.updatedContent, changelog);
});
