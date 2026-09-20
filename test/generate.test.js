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
  extractCodeSpans,
  areBulletsDuplicates,
  pickMoreDetailedBullet,
  canonicalizeHeadingName,
  classifyBulletCategory,
  parseChangelogGroups,
  canonicalizeChangelogBody,
  buildCompareUrl,
  upsertReleaseLinkReference,
  preservesAllMarkers,
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

test('mergePreservingExistingUnreleased expands a thin existing bullet in place instead of duplicating it', () => {
  const existing = [
    '### Changed',
    '- Frodo shell autocomplete and `help()` output now indicate which parameters are optional.',
    '- Updated `@rockcarver/frodo-lib` to version 4.4.1, which may include improvements affecting the behavior and performance of Frodo CLI. (3239da2a)',
  ].join('\n');

  const generated = [
    '### Changed',
    '- Frodo shell autocomplete and `help()` output now indicate which parameters are optional. The shell autocomplete scaffolds append `?` to parameter names marked as optional, and the `help()` output labels optional parameters with a `(optional)` tag. (#668, 66b9f1e7)',
  ].join('\n');

  const merged = mergePreservingExistingUnreleased(existing, generated);

  // The expanded wording replaces the thin bullet in place...
  assert.match(merged, /scaffolds append `\?` to parameter names/);
  // ...and there is no second, separate bullet restating the same change.
  const occurrences = (merged.match(/parameters are optional/g) || []).length;
  assert.equal(occurrences, 1);
  // Unrelated existing bullets are untouched.
  assert.match(merged, /Updated `@rockcarver\/frodo-lib` to version 4\.4\.1/);
});

test('mergePreservingExistingUnreleased keeps a sufficiently detailed existing bullet as-is', () => {
  const existing = [
    '### Changed',
    '- Frodo shell autocomplete and `help()` output now indicate which parameters are optional. The shell autocomplete scaffolds append `?` to parameter names marked as optional, and the `help()` output labels optional parameters with a `(optional)` tag. (#668, 66b9f1e7)',
  ].join('\n');

  const generated = [
    '### Changed',
    '- Frodo shell autocomplete and `help()` output now indicate which parameters are optional. (#668, 66b9f1e7)',
  ].join('\n');

  const merged = mergePreservingExistingUnreleased(existing, generated);

  assert.equal(merged, existing);
});

test('mergePreservingExistingUnreleased tightens a verbose existing bullet when the rewrite keeps its flag and evidence', () => {
  const existing = [
    '### Added',
    '- Added `--foo <value>` to the server. This is necessary because a number of authorization servers in the wild have historically required this kind of configuration knob to be present before they will cooperate, and without it the flow simply cannot proceed in a great many real-world deployments we have tested against. (#123)',
  ].join('\n');

  const generated = [
    '### Added',
    '- Added `--foo <value>` to the server, required by authorization servers that need this configuration up front. (#123)',
  ].join('\n');

  const merged = mergePreservingExistingUnreleased(existing, generated);
  assert.equal(merged, generated);
});

test('mergePreservingExistingUnreleased refuses to shorten an existing bullet when the rewrite drops its flag or evidence', () => {
  const existing = [
    '### Added',
    '- Added `--foo <value>` and `--bar` to the server for authorization. (#123)',
  ].join('\n');

  // Drops `--bar` and the PR reference - not a safe tightening.
  const droppedFlag = [
    '### Added',
    '- Added `--foo <value>` to the server for authorization.',
  ].join('\n');

  assert.equal(mergePreservingExistingUnreleased(existing, droppedFlag), existing);
});

test('preservesAllMarkers requires at least one flag to anchor on, and checks evidence too', () => {
  assert.equal(preservesAllMarkers('Just some prose with no flag. (#1)', 'Shorter prose. (#1)'), false);
  assert.equal(
    preservesAllMarkers('Added `--foo` to do X. (#1)', 'Added `--foo` to do X.'),
    false
  );
  assert.equal(
    preservesAllMarkers('Added `--foo` and `--bar` to do X. (#1)', 'Added `--foo` to do X. (#1)'),
    false
  );
  assert.equal(
    preservesAllMarkers('Added `--foo` to do X in great detail. (#1)', 'Added `--foo` to do X. (#1)'),
    true
  );
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

test('extractCodeSpans keeps only the first flag-shaped span, ignoring later cross-references', () => {
  assert.deepEqual(extractCodeSpans('Added `--oauth-scope <scope...>` to the server.'), new Set(['--oauth-scope']));
  assert.deepEqual(
    extractCodeSpans('Reached only after fixing `--registered-client-id`\'s proxy (see above).'),
    new Set(['--registered-client-id'])
  );
  // A leading non-flag command-name span is skipped in favor of a later flag span.
  assert.deepEqual(
    extractCodeSpans('Fixed `frodo mcp server start --dry-run` never validating `--claims-config`.'),
    new Set(['--claims-config'])
  );
  // No flag-shaped span anywhere in the bullet.
  assert.deepEqual(extractCodeSpans('Added `config-manager push saml` command.'), new Set());
  assert.deepEqual(extractCodeSpans(''), new Set());
});

test('areBulletsDuplicates matches on exact text, containment, or a shared subject flag', () => {
  assert.equal(areBulletsDuplicates('', 'anything'), false);

  // Exact text match.
  assert.equal(areBulletsDuplicates('- Fixed the thing.', '- Fixed the thing.'), true);

  // Same subject flag, worded differently.
  assert.equal(
    areBulletsDuplicates(
      'Added `--bind-host <host>` to control the bind address.',
      'Introduced `--bind-host` for overriding the bind address in tests.'
    ),
    true
  );

  // Mentioning a DIFFERENT flag in passing must not create a false match.
  assert.equal(
    areBulletsDuplicates(
      'Added `--oauth-scope <scope...>` to the server, reached only after fixing `--registered-client-id`\'s proxy (see above).',
      'Added `--registered-client-id <client-id>` to the server, turning it into a lightweight OAuth proxy.'
    ),
    false
  );

  // Two short, distinct bullets naming no flag must not collide once their
  // only distinguishing (backtick) content is stripped for comparison.
  assert.equal(
    areBulletsDuplicates(
      'Added `config-manager pull and push metadata` commands, enabling the pulling and pushing of configuration metadata.',
      'Added `config-manager push saml` command, enabling the pushing of SAML configurations.'
    ),
    false
  );
});

test('pickMoreDetailedBullet prefers the longer bullet, and evidence tags break close ties', () => {
  const long = 'Added `--foo` to the server, doing a great many detailed and specific things worth describing at length.';
  const short = 'Added `--foo` to the server. (commit abc1234)';
  assert.equal(pickMoreDetailedBullet(long, short), long);
  assert.equal(pickMoreDetailedBullet('', short), short);
  assert.equal(pickMoreDetailedBullet(long, ''), long);

  const withEvidence = 'Added `--foo` to the server for real this time.';
  const withoutEvidence = 'Added `--foo` to the server for real this time now';
  // Nearly identical length: whichever has grounding evidence wins.
  assert.equal(
    pickMoreDetailedBullet(withoutEvidence, `${withEvidence} (#42)`),
    `${withEvidence} (#42)`
  );
});

test('classifyBulletCategory recognizes confident leading verbs and returns null otherwise', () => {
  assert.equal(classifyBulletCategory('Added `--foo` support.'), 'Added');
  assert.equal(classifyBulletCategory('Introduced a new command.'), 'Added');
  assert.equal(classifyBulletCategory('Removed the legacy flag.'), 'Removed');
  assert.equal(classifyBulletCategory('Deprecated the old alias.'), 'Deprecated');
  assert.equal(classifyBulletCategory('Fixed a crash on startup.'), 'Fixed');
  assert.equal(classifyBulletCategory('Resolved a race condition.'), 'Fixed');
  assert.equal(classifyBulletCategory('Patched a security vulnerability in the parser.'), 'Security');
  assert.equal(classifyBulletCategory('Improved error handling in OAuth flows.'), null);
  assert.equal(classifyBulletCategory('`frodo mcp server start` now logs more.'), null);
});

test('canonicalizeHeadingName maps case-insensitively and rejects non-standard headings', () => {
  assert.equal(canonicalizeHeadingName('Added'), 'Added');
  assert.equal(canonicalizeHeadingName('added'), 'Added');
  assert.equal(canonicalizeHeadingName('CHANGED'), 'Changed');
  assert.equal(canonicalizeHeadingName('Updated'), null);
  assert.equal(canonicalizeHeadingName('Documentation'), null);
  assert.equal(canonicalizeHeadingName(null), null);
  assert.equal(canonicalizeHeadingName(''), null);
});

test('parseChangelogGroups splits on headings and buckets leading bullets as headless', () => {
  const body = [
    '- Leading headless bullet',
    '### Added',
    '- First added bullet',
    '- Second added bullet',
    '### Fixed',
    '- A fix',
  ].join('\n');

  const groups = parseChangelogGroups(body);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].heading, null);
  assert.deepEqual(groups[0].bullets, ['- Leading headless bullet']);
  assert.equal(groups[1].heading, 'Added');
  assert.equal(groups[1].bullets.length, 2);
  assert.equal(groups[2].heading, 'Fixed');
  assert.deepEqual(groups[2].bullets, ['- A fix']);
});

test('canonicalizeChangelogBody folds a non-standard heading into Changed and enforces canonical order', () => {
  const body = [
    '### Fixed',
    '- A real fix. (#1)',
    '',
    '### Updated',
    '- Some ambiguous update. (#2)',
    '',
    '### Added',
    '- A new capability. (#3)',
  ].join('\n');

  const result = canonicalizeChangelogBody(body);
  const addedIndex = result.indexOf('### Added');
  const changedIndex = result.indexOf('### Changed');
  const fixedIndex = result.indexOf('### Fixed');

  assert.notEqual(addedIndex, -1);
  assert.notEqual(changedIndex, -1);
  assert.notEqual(fixedIndex, -1);
  assert.ok(addedIndex < changedIndex, 'Added must come before Changed');
  assert.ok(changedIndex < fixedIndex, 'Changed must come before Fixed');
  assert.match(result, /### Changed\n- Some ambiguous update\. \(#2\)/);
  assert.doesNotMatch(result, /### Updated/);
});

test('canonicalizeChangelogBody is idempotent', () => {
  const body = [
    '### Added',
    '- A new capability. (#3)',
    '### Fixed',
    '- A real fix. (#1)',
  ].join('\n');

  const once = canonicalizeChangelogBody(body);
  const twice = canonicalizeChangelogBody(once);
  assert.equal(twice, once);
  assert.equal(canonicalizeChangelogBody(''), '');
});

test('canonicalizeChangelogBody folds a fix to an unreleased capability into its Added entry', () => {
  const body = [
    '### Added',
    '- Added `--foo <value>` to control the thing.',
    '### Fixed',
    '- Fixed `--foo`\'s handling of empty values, which previously crashed. (commit abc1234)',
  ].join('\n');

  const result = canonicalizeChangelogBody(body);
  assert.match(result, /^### Added$/m);
  assert.doesNotMatch(result, /### Fixed/);
  // The more detailed (Fixed) wording survives, filed under Added.
  assert.match(result, /handling of empty values/);
});

test('canonicalizeChangelogBody regression: real frodo-cli v4.15.0 duplicate/mis-heading bug', () => {
  // Verbatim from the published frodo-cli CHANGELOG.md v4.15.0 section: a
  // detailed, hand-written Added block and Fixed block are followed by a
  // headless block of terser AI-regenerated near-duplicates (some citing the
  // wrong commit-evidence-only phrasing), then a Changed block that
  // re-duplicates the Fixed block again.
  const body = [
    '### Added',
    '- `frodo mcp server start`\'s startup summary now includes the external-IDP issuer, audience, and the full claims-config mapping table whenever `--external-idp-issuer` is configured — previously none of that appeared anywhere in startup output.',
    '- Added `--public-url <url>` to `frodo mcp server start`, overriding the RFC 9728 `resource` value advertised in discovery metadata for cases that can\'t self-correct via the fix below.',
    '- Added `--registered-client-id <client-id>` to `frodo mcp server start --oauth-resource-server`, turning this server into a lightweight OAuth proxy for three endpoints on behalf of a single, pre-provisioned, public client_id already registered directly with AM/AIC or the external IDP.',
    '- Added `--oauth-scope <scope...>` to `frodo mcp server start --oauth-resource-server`, naming the OAuth scope(s) a connecting client should request, reached only after fixing `--registered-client-id`\'s proxy to be discoverable at all (see above).',
    '',
    '### Fixed',
    '- Fixed `frodo conn service-account add` failing with "Invalid URL" when the target host was given as an alias instead of a full URL.',
    '- Fixed `frodo mcp server start --dry-run` never validating `--claims-config` when external-IDP mode is configured.',
    '- Fixed `frodo mcp server start --oauth-resource-server`\'s discovery metadata always advertising itself at `--bind-host` verbatim. See `--public-url` above for the one case this can\'t self-correct.',
    '- Fixed `--registered-client-id`\'s authorize/token proxy relaying the RFC 8707 `resource` parameter straight through to the upstream authorization server.',
    '',
    '- Added `--registered-client-id <client-id>` to `frodo mcp server start --oauth-resource-server`, enabling the server to act as a lightweight OAuth proxy. (commit 8acf5c90)',
    '- Introduced `--oauth-scope <scope...>` to `frodo mcp server start --oauth-resource-server`, specifying the OAuth scopes a connecting client should request. (commit 790b398a)',
    '- Added `--oauth-forward-resource` to `frodo mcp server start`, allowing the forwarding of the RFC 8707 `resource` parameter to authorization servers that support it. (commit 1266a403)',
    '- Added `-a, --active-only` flag to `config-manager pull secrets`, allowing users to export only active secrets. (PR #695)',
    '',
    '### Changed',
    '- Fixed `frodo mcp server start --dry-run` not validating `--claims-config` when external-IDP mode is configured. (commit 46c1cfec)',
    '- Fixed `--registered-client-id`\'s proxy relaying the RFC 8707 `resource` parameter to upstream authorization servers. (commit 940deff4)',
  ].join('\n');

  const result = canonicalizeChangelogBody(body);

  // The rich, hand-written Added bullets survive verbatim.
  assert.match(result, /turning this server into a lightweight OAuth proxy for three endpoints/);
  assert.match(result, /naming the OAuth scope\(s\) a connecting client should request/);

  // Their terser headless/Changed-block duplicates do not appear as separate bullets.
  assert.doesNotMatch(result, /\(commit 8acf5c90\)/);
  assert.doesNotMatch(result, /\(commit 790b398a\)/);

  // The rich Fixed bullets survive, except the one about `--registered-client-id`,
  // which folds into Added since that flag was only introduced in this same
  // Unreleased section (never released in its unfixed form).
  assert.match(result, /always advertising itself at `--bind-host` verbatim/);
  assert.match(result, /failing with "Invalid URL"/);
  assert.doesNotMatch(result, /relaying the RFC 8707 `resource` parameter straight through/);
  assert.doesNotMatch(result, /\(commit 940deff4\)/);

  // Genuinely new bullets from the headless block survive under Added.
  assert.match(result, /--oauth-forward-resource/);
  assert.match(result, /--active-only/);

  // Canonical section order, no non-standard headings, no orphaned headless bullets.
  const addedIndex = result.indexOf('### Added');
  const fixedIndex = result.indexOf('### Fixed');
  assert.notEqual(addedIndex, -1);
  assert.ok(fixedIndex === -1 || addedIndex < fixedIndex);
  // No orphaned/headless bullet group anywhere in the final output.
  assert.ok(parseChangelogGroups(result).every((group) => group.heading !== null));
});

test('buildCompareUrl matches the existing historical link format', () => {
  assert.equal(
    buildCompareUrl('rockcarver', 'frodo-cli', 'v4.3.0', 'v4.3.1'),
    'https://github.com/rockcarver/frodo-cli/compare/v4.3.0...v4.3.1'
  );
});

test('upsertReleaseLinkReference inserts a new tag as the first line of the existing reference block', () => {
  const content = [
    '## [v1.0.1] - 2026-08-01',
    '',
    '- Initial release',
    '',
    '[v1.0.0]: https://github.com/acme/widget/compare/v0.9.0...v1.0.0',
    '[0.9.0]: https://github.com/acme/widget/compare/abc123...v0.9.0',
  ].join('\n');

  const updated = upsertReleaseLinkReference(
    content,
    'v1.0.1',
    'https://github.com/acme/widget/compare/v1.0.0...v1.0.1'
  );

  const lines = updated.split('\n');
  const refIndex = lines.findIndex((line) => line.startsWith('[v1.0.1]:'));
  assert.notEqual(refIndex, -1);
  assert.equal(lines[refIndex], '[v1.0.1]: https://github.com/acme/widget/compare/v1.0.0...v1.0.1');
  // Inserted above the previously-first reference entry.
  assert.equal(lines[refIndex + 1], '[v1.0.0]: https://github.com/acme/widget/compare/v0.9.0...v1.0.0');
});

test('upsertReleaseLinkReference is idempotent and updates an existing entry for the same tag in place', () => {
  const base = [
    '# Changelog',
    '',
    '[v1.0.0]: https://github.com/acme/widget/compare/v0.9.0...v1.0.0',
  ].join('\n');

  const first = upsertReleaseLinkReference(base, 'v1.0.1', 'https://github.com/acme/widget/compare/v1.0.0...v1.0.1');
  const second = upsertReleaseLinkReference(first, 'v1.0.1', 'https://github.com/acme/widget/compare/v1.0.0...v1.0.1');
  assert.equal(second, first);

  const updated = upsertReleaseLinkReference(first, 'v1.0.1', 'https://github.com/acme/widget/compare/DIFFERENT...v1.0.1');
  const refLines = updated.split('\n').filter((line) => line.startsWith('[v1.0.1]:'));
  assert.equal(refLines.length, 1);
  assert.equal(refLines[0], '[v1.0.1]: https://github.com/acme/widget/compare/DIFFERENT...v1.0.1');
});

test('upsertReleaseLinkReference appends a fresh block when none exists yet', () => {
  const base = '# Changelog\n\n## [v1.0.0] - 2026-08-01\n\n- Initial release\n';
  const updated = upsertReleaseLinkReference(base, 'v1.0.0', 'https://github.com/acme/widget/releases/tag/v1.0.0');
  assert.match(updated, /\n\n\[v1\.0\.0\]: https:\/\/github\.com\/acme\/widget\/releases\/tag\/v1\.0\.0\n$/);
});
