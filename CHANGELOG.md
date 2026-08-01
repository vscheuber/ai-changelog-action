# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## Unreleased

## [v1.1.3] - 2026-08-01

### Added
- Implemented stable semantic versioning (semver) tag detection to improve version management and ensure consistent versioning practices. (#27e7827)
- Enhanced changelog generation by normalizing the output from the language model, leading to clearer and more consistent changelog entries. (#27e7827)
- Added support for promoting Unreleased content to a versioned changelog section, streamlining the release process and ensuring accurate documentation of changes. This enhancement improves workflow efficiency for users managing changelog updates. (commit 49efe6f)
- Added functions for file change detection and fallback release note classification, enhancing the tool's ability to handle changes more effectively. (commit b678843)
- Introduced `hasMeaningfulReleaseInput` function with corresponding tests to improve the accuracy of release note generation. (commit 321a414)
- Implemented `removeDuplicateReleaseLines` function and added tests to ensure deduplication of release notes, enhancing the clarity and usability of changelog entries. (commit e7ec998)

### Changed
- Enhanced `buildPrompt` functionality to include previous release notes and guidelines, preventing the restatement of changes across releases. This improvement aids in maintaining concise and relevant changelog entries. (commit 4e07f06)

## [v1.1.2] - 2026-08-01

### Added
- Enhanced `buildPrompt` functionality to include previous release notes and guidelines, preventing the restatement of changes across releases. This improvement aids in maintaining concise and relevant changelog entries. (commit 4e07f06)

### Added (from pre-releases)
- Implemented stable semantic versioning (semver) tag detection to improve version management and ensure consistent versioning practices. (#27e7827)
- Enhanced changelog generation by normalizing the output from the language model, leading to clearer and more consistent changelog entries. (#27e7827)
- Added support for promoting Unreleased content to a versioned changelog section, streamlining the release process and ensuring accurate documentation of changes. This enhancement improves workflow efficiency for users managing changelog updates. (commit 49efe6f)
- Added functions for file change detection and fallback release note classification, enhancing the tool's ability to handle changes more effectively. (commit b678843)
- Introduced `hasMeaningfulReleaseInput` function with corresponding tests to improve the accuracy of release note generation. (commit 321a414)

## [v1.1.1] - 2026-08-01

### Added
- Implemented stable semantic versioning (semver) tag detection to improve version management and ensure consistent versioning practices. (#27e7827)
- Enhanced changelog generation by normalizing the output from the language model, leading to clearer and more consistent changelog entries. (#27e7827)
- Added support for promoting Unreleased content to a versioned changelog section, streamlining the release process and ensuring accurate documentation of changes. This enhancement improves workflow efficiency for users managing changelog updates. (commit 49efe6f)
- Added functions for file change detection and fallback release note classification, enhancing the tool's ability to handle changes more effectively. (commit b678843)
- Introduced `hasMeaningfulReleaseInput` function with corresponding tests to improve the accuracy of release note generation. (commit 321a414)

## [v1.1.0] - 2026-08-01

### Added
- Implemented stable semantic versioning (semver) tag detection to improve version management and ensure consistent versioning practices. (#27e7827)
- Enhanced changelog generation by normalizing the output from the language model, leading to clearer and more consistent changelog entries. (#27e7827)
- Added support for promoting Unreleased content to a versioned changelog section, streamlining the release process and ensuring accurate documentation of changes. This enhancement improves workflow efficiency for users managing changelog updates. (commit 49efe6f)

## [v1.0.8-1] - 2026-08-01

### Added
- Support for promoting Unreleased content to a versioned changelog section, streamlining the release process and ensuring accurate documentation of changes. This enhancement improves workflow efficiency for users managing changelog updates. (commit 49efe6f)

## [v1.0.7] - 2026-08-01

### Added
- Implemented the promotion of release notes into the versioned changelog section, ensuring that users have access to organized and up-to-date release information (e9b47f9).

### Changed
- Simplified the release workflow by removing unused inputs and integrating `version-bump-action` for version computation, streamlining the process for users (#95d160d, #ef54872).
- Updated the release workflow to include package manifest updates and improved changelog commit logic, enhancing the accuracy and completeness of release documentation (e781c2e).

## [v1.0.5] - 2026-07-28

### Added
- Default prerelease tags now use a numeric format, simplifying version management and enhancing the consistency and predictability of version identifiers. (#e47bff3)

### Changed
- Updated GitHub Actions workflows to eliminate runtime warnings for Node 20, improving compatibility and reducing noise in CI/CD logs.

### Fixed
- The prerelease identifier in the release dispatch workflow is now optional, providing more flexibility in release processes and resolving issues where a mandatory identifier was previously required. (#757eebc)

## [v1.0.5-rc.2] - 2026-07-28

### Added
- Default prerelease tags now use a numeric format, simplifying version management for users. This change enhances the consistency and predictability of version identifiers. (#e47bff3)

### Fixed
- The prerelease identifier in the release dispatch workflow is now optional, allowing for more flexible release processes. This fix resolves issues where a mandatory identifier was previously required. (#757eebc)

## [v1.0.5-rc.1] - 2026-07-28

### Changed
- Updated GitHub Actions workflows to eliminate runtime warnings for Node 20, enhancing compatibility and reducing noise in CI/CD logs.

## [v1.0.4] - 2026-07-28

### Added
- Introduced a `force-release` commit gate to the release workflow, allowing users to trigger a release even if there are no changes since the last release. This provides more control over the release process. (#efc71fc)

### Fixed
- The release pipeline now correctly fails when the changelog is empty, ensuring that releases are only made when there are documented changes. (#5e0d7bd)

## [v1.0.3] - 2026-07-27

- No user-facing changes.

## [v1.0.2] - 2026-07-27

### Added
- Introduced a self-release pipeline to automate the release process, including tests and changelog bootstrap. This enhancement streamlines the workflow for maintaining and releasing new versions. (#81a4029)

### Changed
- Replaced the self-release workflow with a release-type driven release pipeline, enhancing flexibility and control over the release process. (#1f3fb44)
- Updated `action.yml` description for improved clarity, making it easier for users to understand the purpose and usage of the action. (#a651689)

### Documentation
- Enhanced `README.md` with additional information to better guide users on how to utilize the tool effectively. (#81a4029)

## 1.0.0 - 2026-07-26

### Added

- Initial release of AI Changelog Updater.
- Composite GitHub Action for LLM-driven `## Unreleased` changelog generation.
