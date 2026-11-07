/**
 * Stands in for `ssh`. It passes `bases`, `receive` and `related` straight to the real
 * remote-run.sh, so packs truly travel between repositories, and acts out `run` and `fetch`
 * per scenario. The real `run` is in remote-run.linux.spec.ts.
 */
export const FAKE_SSH = String.raw`#!/bin/bash
cmd="${'$'}{!#}"
echo "$cmd" >> "$FAKE_DIR/ssh.log"
scenario="$(cat "$FAKE_DIR/scenario")"
cd "$FAKE_DIR/home" || exit 255
sha() { sha256sum 2>/dev/null || shasum -a 256; }
case "$cmd" in
  *' receive '*)
    case "$scenario" in
      receive-refuses) head -c 100 >/dev/null; exit 1 ;;
      receive-drops) head -c 100 >/dev/null; exit 255 ;;
    esac
    exec bash -c "$cmd"
    ;;
  *' run '*)
    set -- $cmd
    commit="$5"
    echo "$cmd" > "$FAKE_DIR/run-args"
    [ -f "remote-checks/runs/$4/related.json" ] && cp "remote-checks/runs/$4/related.json" "$FAKE_DIR/related-list"
    repo=remote-checks/repo.git
    tree="$(git -C "$repo" rev-parse "$commit^{tree}")"
    node="$(git -C "$repo" cat-file blob "$commit:.nvmrc")"
    lock="$(git -C "$repo" cat-file blob "$commit:package-lock.json" | sha | cut -d' ' -f1)"
    code=0
    case "$scenario" in
      wrong-tree) tree=0000000000000000000000000000000000000000 ;;
      wrong-node) node=v0.0.0 ;;
      wrong-lock) lock=0000 ;;
      tests-fail|crash-clean-report) code=1 ;;
      exit-75) code=75 ;;
    esac
    echo '[test pool] 8 test worker(s); far machine output'
    case "$scenario" in
      lost) exit 255 ;;
      no-result) exit 0 ;;
      no-slot) echo 'AIO_REMOTE_RESULT {"status":"no-slot","exit":1}'; exit 0 ;;
      setup-failed) echo 'AIO_REMOTE_RESULT {"status":"setup-failed","reason":"npm ci failed","exit":1}'; exit 0 ;;
    esac
    echo "AIO_REMOTE_RESULT {\"status\":\"ok\",\"reason\":\"\",\"exit\":$code,\"tree\":\"$tree\",\"node\":\"$node\",\"lock\":\"$lock\",\"root\":\"/far/slots/1/repo\"}"
    ;;
  *' fetch '*)
    case "$scenario" in
      missing-report) exit 1 ;;
      mac-only-ran) printf '%s' '{"numTotalTests":1,"numPassedTests":1,"numFailedTests":0,"testResults":[{"name":"/far/slots/1/repo/src/main/sandbox/signal-fence.spec.ts","status":"passed","assertionResults":[{"status":"passed","title":"a","fullName":"a","failureMessages":[]}]}]}' | gzip -c ;;
      empty-report) printf '{"numTotalTests":0,"testResults":[]}' | gzip -c ;;
      tests-fail|failed-report-clean-exit) printf '%s' '{"numTotalTests":1,"numPassedTests":0,"numFailedTests":1,"testResults":[{"name":"/far/slots/1/repo/src/a.spec.ts","status":"failed","assertionResults":[{"status":"failed","title":"a","fullName":"a","failureMessages":["boom at /far/slots/1/repo/src/a.spec.ts:1"]}]}]}' | gzip -c ;;
      *) printf '%s' '{"numTotalTests":1,"numPassedTests":1,"numFailedTests":0,"testResults":[{"name":"/far/slots/1/repo/src/a.spec.ts","status":"passed","assertionResults":[{"status":"passed","title":"a","fullName":"a","failureMessages":[]}]}]}' | gzip -c ;;
    esac
    ;;
  *)
    [ "$scenario" = unreachable ] && exit 255
    exec bash -c "$cmd"
    ;;
esac
`;
