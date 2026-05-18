# Claude instructions

## Pull requests and releases

- Use Conventional Commit style for PR titles and squash/merge commit titles so `release-please` can parse them.
- Allowed PR title types are `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, and `ci`.
- Examples: `feat: add package search filters`, `fix: handle missing SAP spec metadata`, `ci: update release workflow`.
- Keep the release version source of truth in `package.json`; do not add a separate `VERSION` file.
