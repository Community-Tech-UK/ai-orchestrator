import pathlib,subprocess,json,time
out=pathlib.Path(__file__).parent
commands={
'benchmark-tests':['node_modules/.bin/vitest','run','--config','benchmarks/plan-execute-ab/vitest.config.ts','--maxWorkers=1','--reporter=json','--outputFile='+str(out/'benchmark-tests.json')],
'benchmark-typecheck':['node_modules/.bin/tsc','--noEmit','-p','benchmarks/plan-execute-ab/tsconfig.json'],
'changed-lint':['node_modules/.bin/eslint','--no-cache']+['benchmarks/plan-execute-ab/config.spec.ts', 'benchmarks/plan-execute-ab/runner.spec.ts', 'benchmarks/plan-execute-ab/runner.ts', 'benchmarks/plan-execute-ab/scorer.ts', 'benchmarks/plan-execute-ab/task-bank.ts', 'benchmarks/plan-execute-ab/task-export.spec.ts', 'benchmarks/plan-execute-ab/types.ts', 'benchmarks/plan-execute-ab/scoring-setup.ts', 'benchmarks/plan-execute-ab/scoring-setup.spec.ts', 'benchmarks/plan-execute-ab/local-anthropic-proxy.ts', 'benchmarks/plan-execute-ab/local-anthropic-proxy.spec.ts'],
'diff-check':['git','diff','--check'],
}
for label,argv in commands.items():
 started=time.time();r=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 (out/(label+'.log')).write_bytes(r.stdout)
 receipt={'argv':argv,'exitCode':r.returncode,'durationSeconds':time.time()-started}
 (out/(label+'.receipt.json')).write_text(json.dumps(receipt,indent=2))
 print(label+': exit '+str(r.returncode),flush=True)
