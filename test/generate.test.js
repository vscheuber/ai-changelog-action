const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPreRelease,
  extractUnreleased,
  extractChangelogSections,
  buildPrompt,
} = require('../scripts/generate');

test('isPreRelease detects stable and pre-release versions', () => {
  assert.equal(isPreRelease('1.2.3'), false);
  assert.equal(isPreRelease('1.2.3-beta.1'), true);
  assert.equal(isPreRelease('v2.0.0-rc1'), true);
  assert.equal(isPreRelease('4.1.2-1'), true);
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
