# Autora: rules for every change

## Release every change that reaches the container (CI enforces this)

The "Release version" workflow (`.github/scripts/check_release.py`) fails any
change to `src/`, `server/`, `server.ts`, `package.json`, `public/`, `ui/src/`,
`ui/public/`, `ui/index.html`, `ui/package.json`, `Dockerfile` or
`blofstedt-autora/docker-compose.yml` unless the same branch also:

1. Bumps `version` in `blofstedt-autora/umbrel-app.yml` to a higher number
   (patch bump by default, e.g. 0.9.1 -> 0.9.2).
2. Sets `"version"` in `package.json` (and the top two `"version"` fields in
   `package-lock.json`) to that same number, and the image tag in
   `blofstedt-autora/docker-compose.yml` (`ghcr.io/blofstedt/autora:<version>`)
   too. Never `:latest`: an update taken while the image was building would
   install the previous build and never be offered again.
3. Rewrites `releaseNotes` in `umbrel-app.yml` to describe this change, not
   the last release. If the change contradicts the manifest's `description`,
   update that too.

Do this in the same commit as the code change, without being asked. Before
pushing, run the check locally and make sure it passes:

```bash
git fetch -q origin main && python3 .github/scripts/check_release.py --base origin/main --head HEAD
```

Only when a change genuinely has no user-facing effect, skip the bump and put
`[no release]` in the pull request title or body instead.

## Other checks before pushing

- `npm run lint` (typechecks client and server)
- `npm run build`

## Standing product decisions

- Autora always runs in yolo mode: no tool call waits for approval in chat.
  `needsApproval` in `server/tools.ts` returns false. Don't reintroduce
  approval prompts or an "Ask me first" setting unless asked.
