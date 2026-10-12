# ha-doorbell-intercom

Home Assistant add-on: video intercom for any HA doorbell (live video via WebRTC/go2rtc with fallbacks,
two-way audio, ring notifications, sidebar panel). **Public repo**: anything committed is visible to everyone.

## Working here

- Shared rules for all of Ahmed's repos (Git workflow, security, how to talk to him) are in
  `C:\Users\ahmed\Development\CLAUDE.md` when working on his PC. In short: branch + PR, Conventional Commits,
  never commit secrets, update the README with every change, give commit message + PR title + PR description.
- Layout: `doorbell_intercom/` is the add-on (`config.yaml`, `build.yaml`, `Dockerfile`, `run.sh`);
  `server/` is the Node backend (`server.js`), `ui/` the browser client. `repository.yaml` makes this repo an
  add-on repository.
- The server talks to HA with `SUPERVISOR_TOKEN`. Browsers must only ever get configured doorbells and
  stream names: never send them the token, HA URLs or the raw internal go2rtc URL.
- New options go in `config.yaml` (`options` and `schema`) and the README's Configuration section together.
- Releases: `.\deploy.ps1` bumps the patch version in `doorbell_intercom/config.yaml` on a release branch and
  opens an auto-merging PR. HA offers the update from that version.
- `server/node_modules` is git-ignored; run `npm ci` in `doorbell_intercom/server` after pulling.

## Check before done

```bash
cd doorbell_intercom/server && npm ci && npm audit --omit=dev --audit-level=high
node --check doorbell_intercom/server/server.js
node --check doorbell_intercom/ui/app.js
# CI also runs the HA add-on linter and hadolint on the Dockerfile
```
