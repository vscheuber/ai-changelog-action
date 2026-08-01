const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPreRelease,
  isStableSemverTag,
  normalizeGeneratedBody,
  hasMeaningfulReleaseInput,
  extractUnreleased,
  extractChangelogSections,
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

test('buildPrompt includes audience-specific guidance', () => {
  const baseParams = {
    repo: 'vscheuber/ai-changelog-action',
    userFocus: 'library consumers',
    existingUnreleased: '',
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
