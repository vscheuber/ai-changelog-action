# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## Unreleased

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
