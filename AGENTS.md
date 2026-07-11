# DolbyX

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

Gotcha: piped (non-TTY) `gh issue view <n> --comments` prints only the comment thread — empty output when 0 comments, exit 0. Read body via `gh issue view <n>`, comments via `--json comments`.

### Triage labels

Default five-label vocabulary, 1:1 with the canonical roles. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
