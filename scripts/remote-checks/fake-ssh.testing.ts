/**
 * Stands in for `ssh`. It passes `bases`, `receive`, `related`, `argv` and `checks` straight to the real
 * remote-run.sh, so packs truly travel between repositories, and acts out `run` and `fetch`
 * per scenario. The real `run` is in remote-run.linux.spec.ts. `no-slot-once` has no free slot
 * the first time it is asked and passes after that.
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
    id="${'$'}{@: -4:1}"
    commit="${'$'}{@: -3:1}"
    echo "$cmd" > "$FAKE_DIR/run-args"
    [ -f "remote-checks/runs/$id/related.json" ] && cp "remote-checks/runs/$id/related.json" "$FAKE_DIR/related-list"
    [ -f "remote-checks/runs/$id/argv.json" ] && cp "remote-checks/runs/$id/argv.json" "$FAKE_DIR/argv-list"
    if [ "$scenario" = no-slot-once ]; then
      if [ -f "$FAKE_DIR/had-no-slot" ]; then scenario=pass; else touch "$FAKE_DIR/had-no-slot"; scenario=no-slot; fi
    fi
    # A list run that ends only after this machine has been asked for another run's report, so a test can tell
    # whether anything waited for it. Gives up after 20 s, when the test has failed anyway.
    if [ -f "remote-checks/runs/$id/related.json" ] && [ -f "$FAKE_DIR/related-waits-for-fetch" ]; then
      for _ in $(seq 1 200); do grep -q ' fetch ' "$FAKE_DIR/ssh.log" && break; sleep 0.1; done
    fi
    [ -f "remote-checks/runs/$id/checks.list" ] && cp "remote-checks/runs/$id/checks.list" "$FAKE_DIR/checks-list"
    repo=remote-checks/repo.git
    node_file=.nvmrc
    lock_file=package-lock.json
    case "$cmd" in
      AIO_PROJECT=*)
        project="${'$'}{1#AIO_PROJECT=}"
        repo="remote-checks/projects/$project/repo.git"
        if [ "$project" = work-finding ]; then
          node_file=apps/desk/.nvmrc
          lock_file=apps/desk/package-lock.json
        fi
        ;;
    esac
    tree="$(git -C "$repo" rev-parse "$commit^{tree}")"
    node="$(git -C "$repo" cat-file blob "$commit:$node_file")"
    lock="$(git -C "$repo" cat-file blob "$commit:$lock_file" | sha | cut -d' ' -f1)"
    code=0
    case "$scenario" in
      wrong-tree) tree=0000000000000000000000000000000000000000 ;;
      wrong-node) node=v0.0.0 ;;
      wrong-lock) lock=0000 ;;
      wrong-major) node=v22.0.0 ;;
      tests-fail|crash-clean-report|failed-with-log|no-tests-fail) code=1 ;;
      checks-fail) code=2 ;;
      exit-75) code=75 ;;
    esac
    echo '[test pool] 8 test worker(s); far machine output'
    case "$scenario" in
      lost) exit 255 ;;
      no-result) exit 0 ;;
      no-slot) echo 'AIO_REMOTE_RESULT {"status":"no-slot","exit":1}'; exit 0 ;;
      setup-failed) echo 'AIO_REMOTE_RESULT {"status":"setup-failed","reason":"npm ci failed","exit":1}'; exit 0 ;;
    esac
    tests=5
    [ "$scenario" = no-tests ] && tests=0
    [ "$node" = 24 ] && node=v24.1.0
    # As node -v prints a full version that a file gives without its v.
    case "$node" in v*) ;; *.*.*) node="v$node" ;; esac
    echo "PASS at /far/slots/1/repo/apps/desk/x.test.ts"
    [ "$scenario" = big-output ] && seq 1 60000 | sed 's/^/far output line /'
    if [ "$scenario" = failed-with-log ]; then
      echo 'short summary'
      echo '[remote checks] full log follows'
      echo 'the long far log /far/slots/1/repo/apps/desk/b.test.ts'
    fi
    echo "AIO_REMOTE_RESULT {\"status\":\"ok\",\"reason\":\"\",\"exit\":$code,\"tree\":\"$tree\",\"node\":\"$node\",\"lock\":\"$lock\",\"root\":\"/far/slots/1/repo\",\"tests\":$tests}"
    ;;
  *' fetch '*)
    set -- $cmd
    list="remote-checks/runs/${'$'}{@: -1}/checks.list"
    if [ -f "$list" ]; then
      # Each check passes, or the second fails naming a far path; checks-short answers for one too few.
      node -e '
        const checks = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
        const scenario = process.argv[2];
        const results = checks.map((command, at) => {
          const fails = scenario === "checks-fail" && at === 1;
          return { command, exitCode: fails ? 2 : 0, durationMs: 1000,
            output: fails ? "src/x.ts(1,1): error TS2322 at /far/slots/1/repo/src/x.ts\n" : "far ok\n" };
        });
        process.stdout.write(JSON.stringify(scenario === "checks-short" ? results.slice(1) : results));
      ' "$list" "$scenario" | gzip -c
      exit 0
    fi
    case "$scenario" in
      missing-report) exit 1 ;;
      mac-only-ran) printf '%s' '{"numTotalTests":1,"numPassedTests":1,"numFailedTests":0,"testResults":[{"name":"/far/slots/1/repo/src/main/sandbox/signal-fence.spec.ts","status":"passed","assertionResults":[{"status":"passed","title":"a","fullName":"a","failureMessages":[]}]}]}' | gzip -c ;;
      empty-report) printf '{"numTotalTests":0,"testResults":[]}' | gzip -c ;;
      # A spec that fails to load: Vitest reports the file as failed and no tests at all.
      no-tests-fail) printf '%s' '{"numTotalTests":0,"numPassedTests":0,"numFailedTests":0,"numFailedTestSuites":1,"testResults":[{"name":"/far/slots/1/repo/src/a.spec.ts","status":"failed","message":"Failed to load url ./missing","assertionResults":[]}]}' | gzip -c ;;
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
