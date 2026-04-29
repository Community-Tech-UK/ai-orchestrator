# Runbook Screenshots

Wave 7 keeps screenshots under `docs/runbooks/screenshots/<wave>/`.

Default policy: screenshots should be captured from the packaged app after the automated gates pass, using macOS light and dark appearance at 100% zoom. Do not use renderer-only captures as packaging proof.

Wave 7 exception: the screenshots in `wave-7/` were captured from an isolated dev-renderer benchmark session to avoid controlling or replacing any installed/running user app. Packaged validation is recorded separately in `docs/runbooks/wave-7-smoke-results.md` through `npm run localbuild` and `npm run smoke:electron`.
