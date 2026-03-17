# Contributing to Phasr

Thanks for contributing.

## Ground Rules

- Be respectful and follow `CODE_OF_CONDUCT.md`.
- Keep changes focused and reviewable.
- Do not commit secrets, tokens, certs, or private keys.

## Development Setup

```bash
make ui-install
make build
go test ./...
```

For desktop work:

```bash
make desktop-build
```

## Branching and PRs

1. Create a branch from `main`.
2. Implement your change with tests or validation.
3. Run relevant checks:
   - `go test ./...`
   - `make ui-build` if frontend changed
   - `make desktop-build` if desktop/runtime scripts changed
4. Open a PR with:
   - What changed
   - Why it changed
   - How it was tested

## Commit Guidance

- Use clear, imperative commit messages.
- Keep unrelated refactors out of feature/fix commits.

## Security

- Do not open public issues for security vulnerabilities.
- Follow `SECURITY.md` for private reporting.
