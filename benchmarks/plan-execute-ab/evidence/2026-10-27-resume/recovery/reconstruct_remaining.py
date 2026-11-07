"""Restricted, offline reconstruction. Historical shell commands are never run."""
import ast
import builtins
import collections
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import types
import fnmatch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
CHECKPOINT = '9cc19c6d6c57267566cace5dac0d1999beb57780'
REPOS = {'ai-orchestrator': ROOT, '12steps': Path('/Users/suas/work/12steps')}
bank = json.loads(subprocess.check_output(['rtk', 'proxy', 'git', 'show', CHECKPOINT + ':benchmarks/plan-execute-ab/tasks/task-bank.json']))
TASKS = {x['id']: x for x in bank['tasks']}


def sha(b):
    return hashlib.sha256(b).hexdigest()


def original(task, rel):
    p = subprocess.run(['rtk', 'proxy', 'git', '-C', str(REPOS[task['repoId']]), 'show', task['parentSha'] + ':' + rel], capture_output=True)
    if p.returncode:
        raise FileNotFoundError(rel)
    return p.stdout.decode()


class VirtualFiles:
    def __init__(self, task, cell):
        self.task, self.cell, self.files, self.cwd = task, cell, {}, ''

    def path(self, name):
        name = str(name)
        for prefix in [f'/private/tmp/plan-execute-ab/{self.cell}-1/', f'/tmp/plan-execute-ab/{self.cell}-1/']:
            if name.startswith(prefix):
                return name[len(prefix):]
        if name.startswith('/'):
            raise ValueError('Path outside candidate: ' + name)
        rel = os.path.normpath(os.path.join(self.cwd, name))
        if rel.startswith('..'):
            raise ValueError('Path escapes candidate: ' + name)
        return rel

    def read(self, name):
        rel = self.path(name)
        if rel not in self.files:
            self.files[rel] = original(self.task, rel)
        return self.files[rel]

    def write(self, name, text):
        self.files[self.path(name)] = text

    def open(self, name, mode='r', **kwargs):
        assert mode in ('r', 'w', 'a'), mode
        owner = self

        class Text(io.StringIO):
            def close(self):
                if mode in ('w', 'a') and not self.closed:
                    owner.write(name, self.getvalue())
                super().close()

            def write(self, text):
                result = super().write(text)
                owner.write(name, self.getvalue())
                return result

        result = Text(self.read(name) if mode in ('r', 'a') else '')
        if mode == 'a':
            result.seek(0, 2)
        return result

    def python(self, script):
        tree = ast.parse(script)
        forbidden = (ast.While, ast.ClassDef, ast.AsyncFunctionDef, ast.Await)
        for node in ast.walk(tree):
            if isinstance(node, forbidden):
                raise ValueError('Unsupported Python AST ' + type(node).__name__)
            if isinstance(node, ast.Attribute) and node.attr.startswith('_'):
                raise ValueError('Private attribute access forbidden')
            if isinstance(node, ast.Name) and node.id.startswith('__'):
                raise ValueError('Private name access forbidden')
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                modules = [x.name for x in node.names] if isinstance(node, ast.Import) else [node.module]
                if any(x not in ('re', 'json', 'collections', 'pathlib', 'subprocess') for x in modules):
                    raise ValueError('Unsupported import ' + str(modules))
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id in ('eval', 'exec', 'compile', 'getattr', 'setattr', 'delattr', 'globals', 'locals', 'input', 'breakpoint'):
                    raise ValueError('Unsupported call ' + node.func.id)
                if isinstance(node.func, ast.Attribute) and node.func.attr not in {
                    'read', 'write', 'close', 'replace', 'rstrip', 'lstrip', 'strip', 'split', 'splitlines', 'join', 'index', 'rindex', 'find', 'rfind', 'count',
                    'startswith', 'endswith', 'format', 'lower', 'upper', 'loads', 'dumps', 'load', 'dump', 'sub', 'subn', 'search', 'match', 'findall', 'escape',
                    'group', 'groups', 'get', 'pop', 'items', 'keys', 'values', 'append', 'extend', 'insert', 'update', 'setdefault', 'OrderedDict', 'defaultdict', 'read_text', 'write_text', 'mkdir', 'exists', 'resolve', 'run', 'check_output'}:
                    raise ValueError('Unsupported method ' + node.func.attr)
        safe = {name: getattr(builtins, name) for name in ('len', 'str', 'int', 'float', 'bool', 'dict', 'list', 'set', 'tuple', 'enumerate', 'range', 'sorted', 'isinstance', 'min', 'max', 'sum', 'zip', 'any', 'all', 'Exception', 'ValueError', 'AssertionError')}
        safe['print'] = lambda *a, **k: None
        safe['open'] = self.open
        owner = self

        class VirtualPath:
            def __init__(self, name):
                self.rel = owner.path(name)

            def __str__(self):
                return f'/tmp/plan-execute-ab/{owner.cell}-1/' + self.rel

            def __truediv__(self, other):
                return VirtualPath(str(self) + '/' + str(other))

            def read_text(self, **kwargs):
                return owner.read(str(self))

            def write_text(self, text, **kwargs):
                owner.write(str(self), text)
                return len(text)

            def mkdir(self, **kwargs):
                pass

            def resolve(self):
                return self

            @property
            def parent(self):
                return VirtualPath(str(self).rsplit('/', 1)[0])

            def exists(self):
                try:
                    self.read_text()
                    return True
                except FileNotFoundError:
                    return False

        def virtual_check_output(argv, **kwargs):
            assert argv[:3] == ['git', 'diff', '--name-only'], argv
            paths = []
            for rel, text in self.files.items():
                try:
                    old = original(self.task, rel)
                except FileNotFoundError:
                    old = None
                if text != old and rel.endswith('.ts'):
                    paths.append(rel)
            answer = '\n'.join(sorted(paths)) + '\n'
            return answer if kwargs.get('text') else answer.encode()

        def virtual_run(argv, **kwargs):
            assert argv[:4] == ['pnpm', 'exec', 'prettier', '--write'], argv
            for rel in argv[4:]:
                self.format(f'/tmp/plan-execute-ab/{self.cell}-1/' + rel)
            return types.SimpleNamespace(returncode=0)

        safe['__import__'] = lambda name, *a, **k: {'re': re, 'json': json, 'collections': collections, 'pathlib': types.SimpleNamespace(Path=VirtualPath), 'subprocess': types.SimpleNamespace(check_output=virtual_check_output, run=virtual_run)}[name]
        exec(compile(tree, '<restricted captured text edits>', 'exec'), {'__builtins__': safe})

    def format(self, name):
        text = self.read(name)
        program = "const p=require('prettier');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',async()=>process.stdout.write(await p.format(s,{...await p.resolveConfig(process.argv[1]),filepath:process.argv[1]})));"
        formatted = subprocess.check_output(['rtk', 'proxy', 'node', '-e', program, str(REPOS[self.task['repoId']] / self.path(name))], input=text.encode(), cwd=REPOS[self.task['repoId']]).decode()
        self.write(name, formatted)


def tools(source):
    items, order, results = {}, [], {}
    for row, raw in enumerate(source.read_text().split('\n'), 1):
        if not raw:
            continue
        entry = json.loads(raw)
        cs = entry.get('message', {}).get('content', [])
        if not isinstance(cs, list):
            continue
        for x in cs:
            if isinstance(x, dict) and x.get('type') == 'tool_use':
                if x['id'] not in items:
                    order.append(x['id'])
                    items[x['id']] = {'sourceRow': row, 'sourceRowUtf8Sha256': sha(raw.encode()), **x}
                else:
                    items[x['id']]['normalizedInput'] = x.get('input', {})
            if isinstance(x, dict) and x.get('type') == 'tool_result':
                results[x['tool_use_id']] = x
    for key, item in items.items():
        item['originalResult'] = results.get(key, {})
    return [items[x] for x in order]


def python_blocks(command):
    pattern = r"python3(?:\s+-I)?\s+-\s*<<\s*['\"]?(\w+)['\"]?\n(.*?)\n\1(?=\n|$)"
    return list(re.finditer(pattern, command, re.S))


def parse_sed(script, text):
    # Feed a captured sed *program* stdin text, never a historical shell or -i.
    assert not re.search(r'(^|[;}])\s*[wer]\s', script), 'sed filesystem/process command forbidden'
    p = subprocess.run(['rtk', 'proxy', 'sed', '-e', script], input=text, capture_output=True, text=True)
    if p.returncode:
        raise ValueError(p.stderr.strip())
    return p.stdout


def shell_text_operations(command, vf, original_result=None, normalized_input=None):
    events = []
    # Normalized Claude entries include the exact resolved initial directory.
    first = re.match(r'\s*cd\s+([^;&\n]+)', command)
    if not first and normalized_input:
        normalized = normalized_input.get('command', '')
        initial = re.match(r'\s*cd\s+([^;&\n]+)', normalized)
        if initial:
            vf.cwd = initial.group(1).strip().split(f'/{vf.cell}-1', 1)[-1].lstrip('/')
    if first:
        path = shlex.split(first.group(1))[0]
        if f'/{vf.cell}-1' in path:
            vf.cwd = path.split(f'/{vf.cell}-1', 1)[1].lstrip('/')
    blocks = python_blocks(command)
    covered = [(m.start(), m.end()) for m in blocks]
    for m in blocks:
        script = m.group(2)
        if re.search(r"open\([^\n]*['\"](?:w|a)['\"]|\.write(?:_text)?\(", script):
            events.append((m.start(), 'python', script))
    for m in re.finditer(r"cat\s*(>>|>)\s*([^\s;]+)\s*<<\s*['\"]?(\w+)['\"]?\n(.*?)\n\3(?=\n|$)", command, re.S):
        if not any(a <= m.start() < b for a, b in covered):
            events.append((m.start(), 'cat', {'mode': m.group(1), 'path': m.group(2), 'text': m.group(4) + '\n'}))
            covered.append((m.start(), m.end()))
    failed_sed = 'sed:' in str((original_result or {}).get('content', ''))
    for m in re.finditer(r"sed\s+-i(?:\s+''|\s+\"\")?\s+('(?:[^']*)'|\"(?:[^\"\\]|\\.)*\")\s+([^\s;&|]+)", command, re.S):
        if not any(a <= m.start() < b for a, b in covered):
            rawscript = m.group(1)
            script = rawscript[1:-1]
            if rawscript.startswith('"'):
                script = script.replace('\\$', '$').replace('\\"', '"')
            if not failed_sed:
                events.append((m.start(), 'sed', {'script': script, 'path': m.group(2)}))
    for m in re.finditer(r'git (?:checkout|restore)(?: --)? ([^;&\n]+)', command):
        for name in shlex.split(m.group(1)):
            if name.startswith('-'):
                continue
            events.append((m.start(), 'reset-parent-file', name))
    for m in re.finditer(r'(?:pnpm exec|npx) prettier (?:--write|-w) ([^;&\n<>]+)', command):
        events.append((m.start(), 'prettier', shlex.split(m.group(1))))
    # Short-lived cp/mutate/cp probes restore the exact original bytes; no replay.
    if re.search(r'cp\s+\S+\s+/tmp/\S+', command) and re.search(r'cp\s+/tmp/\S+\s+\S+', command):
        events = [x for x in events if x[1] not in ('sed', 'reset-parent-file')]
    operations = []
    initial_cwd = vf.cwd
    for offset, kind, payload in sorted(events):
        vf.cwd = initial_cwd
        prefix = command[:offset]
        for a, b in covered:
            if a < offset:
                prefix = prefix[:a] + (' ' * (min(b, offset) - a)) + prefix[min(b, offset):]
        for change in re.finditer(r'(?<!\()\bcd\s+([^;&\n]+)', prefix):
            directory = shlex.split(change.group(1))[0]
            if f'/{vf.cell}-1' in directory:
                vf.cwd = directory.split(f'/{vf.cell}-1', 1)[1].lstrip('/')
            elif not directory.startswith('/'):
                vf.cwd = os.path.normpath(os.path.join(vf.cwd, directory))
        if kind == 'python':
            if 'finally:' in payload and 'fixed = {p: Path(p).read_text() for p in paths}' in payload and 'Path(p).write_text(content)' in payload:
                operations.append({'kind': 'net-noop-baseline-probe-restores-fixed-files', 'payload': payload})
                continue
            vf.python(payload)
        elif kind == 'cat':
            old = vf.read(payload['path']) if payload['mode'] == '>>' else ''
            vf.write(payload['path'], old + payload['text'])
        elif kind == 'sed':
            vf.write(payload['path'], parse_sed(payload['script'], vf.read(payload['path'])))
        elif kind == 'reset-parent-file':
            vf.write(payload, original(vf.task, vf.path(payload)))
        else:
            names = []
            if any('$(' in name for name in payload):
                names = [f'/tmp/plan-execute-ab/{vf.cell}-1/' + x for x in vf.files]
            else:
                for pattern in payload:
                    if any(c in pattern for c in '*?['):
                        wanted = vf.path(pattern)
                        names.extend(f'/tmp/plan-execute-ab/{vf.cell}-1/' + x for x in vf.files if fnmatch.fnmatch(x, wanted))
                    else:
                        names.append(pattern)
            for name in names:
                if name.startswith('-'):
                    continue
                vf.format(name)
        operations.append({'kind': kind, 'payload': payload})
    return operations


def embeddings():
    result = collections.defaultdict(dict)
    folder = Path('/Users/suas/.claude/projects/-Users-suas-work-orchestrat0r-ai-orchestrator--worktrees-queue-2026-10-14-local-model-plan-ex-ca2605')
    for source in folder.glob('*.jsonl'):
        filehash = sha(source.read_bytes())
        for row, raw in enumerate(source.read_text().split('\n'), 1):
            if not raw:
                continue
            c = json.loads(raw).get('message', {}).get('content', [])
            texts = [c] if isinstance(c, str) else [x.get('text', '') for x in c if isinstance(x, dict)] if isinstance(c, list) else []
            for text in texts:
                if 'independent judges' not in text or 'Patch X:\n```diff\n' not in text:
                    continue
                task = next((k for k, t in TASKS.items() if t['prompt'] in text), None)
                if not task:
                    continue
                rest = text.split('Patch X:\n```diff\n', 1)[1]
                if '\n```\n\nPatch Y:\n```diff\n' not in rest:
                    continue
                x, rest = rest.split('\n```\n\nPatch Y:\n```diff\n', 1)
                y = rest.rsplit('\n```\n\nScore EACH patch', 1)[0]
                for side, diff in [('x', x), ('y', y)]:
                    h = sha(diff.encode())
                    entry = result[task].setdefault(h, {'diff': diff, 'sources': []})
                    entry['sources'].append({'source': str(source), 'sourceSha256': filehash, 'sourceRow': row, 'sourceRowUtf8Sha256': sha(raw.encode()), 'side': side})
    return result


def emit(vf, emb):
    parts, files = [], []
    with tempfile.TemporaryDirectory(prefix='replay-files-', dir=HERE) as td:
        for rel, text in sorted(vf.files.items()):
            if rel.split('/')[0] in ('_scratch', 'node_modules') or rel == 'PLAN-agent-output.md':
                continue
            try:
                old = original(vf.task, rel)
            except FileNotFoundError:
                old = None
            if old == text:
                continue
            a, b = Path(td) / 'a' / (rel + '.txt'), Path(td) / 'b' / (rel + '.txt')
            b.parent.mkdir(parents=True, exist_ok=True)
            b.write_text(text)
            if old is not None:
                a.parent.mkdir(parents=True, exist_ok=True)
                a.write_text(old)
            proc = subprocess.run(['rtk', 'proxy', 'git', 'diff', '--no-index', '--abbrev=7', '--', str(a) if old is not None else '/dev/null', str(b)], capture_output=True, text=True)
            assert proc.returncode == 1, proc.stderr
            patch = proc.stdout.replace('a/' + str(a if old is not None else b).lstrip('/'), 'a/' + rel).replace('b/' + str(b).lstrip('/'), 'b/' + rel)
            parts.append(patch)
            files.append({'path': rel, 'bytes': len(text.encode()), 'sha256': sha(text.encode()), 'gitBlobSha1': hashlib.sha1(f'blob {len(text.encode())}\0'.encode() + text.encode()).hexdigest()})
    patch = ''.join(parts)
    stripped = subprocess.check_output(['rtk', 'proxy', 'node', str(HERE / 'strip_judge.cjs')], input=patch.encode()).decode()
    match = emb.get(sha(stripped.encode()))
    return patch, files, match, sha(stripped.encode())


def run_claude(cell, emb):
    task, arm = cell.rsplit('-', 1)
    vf = VirtualFiles(TASKS[task], cell)
    directory = Path('/Users/suas/.claude/projects/-private-tmp-plan-execute-ab-' + cell + '-1')
    sources = sorted(directory.glob('*.jsonl'))
    actions, problems = [], []
    for source in sources:
        sourcehash = sha(source.read_bytes())
        for item in tools(source):
            inp, name = item.get('input', {}), item.get('name')
            provenance = {'source': str(source), 'sourceSha256': sourcehash, 'sourceRow': item['sourceRow'], 'sourceRowUtf8Sha256': item['sourceRowUtf8Sha256'], 'toolId': item['id']}
            try:
                if name in ('Edit', 'Write'):
                    path = inp.get('file_path', '')
                    if f'/{cell}-1/' not in path:
                        continue
                    if name == 'Write':
                        vf.write(path, inp['content'])
                    else:
                        old = vf.read(path)
                        assert inp['old_string'] in old, 'Edit target absent'
                        vf.write(path, old.replace(inp['old_string'], inp['new_string'], -1 if inp.get('replace_all') else 1))
                    actions.append({**provenance, 'operations': [{'kind': name, 'input': inp}]})
                elif name == 'Bash':
                    operations = shell_text_operations(inp.get('command', ''), vf, item.get('originalResult'), item.get('normalizedInput'))
                    if operations:
                        actions.append({**provenance, 'operations': operations})
            except Exception as e:
                problems.append({**provenance, 'reason': type(e).__name__ + ': ' + str(e)[:500], 'command': inp.get('command', '')})
    patch, files, match, normhash = emit(vf, emb.get(task, {}))
    result = {'cell': cell, 'parentCommit': vf.task['parentSha'], 'sourceFiles': [{'source': str(s), 'sha256': sha(s.read_bytes())} for s in sources], 'actions': actions, 'problems': problems, 'candidateFiles': files, 'normalizedDiffSha256': normhash, 'fullOriginalJudgeEmbeddingMatches': match is not None, 'matchedJudgeSources': match['sources'] if match else [], 'status': 'verified-transcript-reconstruction' if match else 'blocked-reconstruction-does-not-match-original-judge-input'}
    if match:
        dest = HERE / 'transcript-reconstruction' / arm / (cell + '-transcript-reconstructed.patch')
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(patch)
        parsed = subprocess.run(['rtk', 'proxy', 'git', 'apply', '--numstat', str(dest)], capture_output=True, text=True)
        result.update({'patchPath': str(dest.relative_to(ROOT)), 'patchSha256': sha(patch.encode()), 'patchBytes': len(patch.encode()), 'gitApplyNumstat': {'exitCode': parsed.returncode, 'stdout': parsed.stdout, 'stderr': parsed.stderr}})
    return result


def context_patch(payload, vf):
    sections = re.split(r'(?m)^\*\*\* (Add|Update|Delete) File: ', payload)
    for i in range(1, len(sections), 2):
        kind, body = sections[i], sections[i + 1]
        path, rest = body.split('\n', 1)
        lines = [x for x in rest.split('\n') if x not in ('*** End Patch', '*** End of File')]
        while lines and lines[-1] == '':
            lines.pop()
        if kind == 'Add':
            assert all(x.startswith('+') for x in lines)
            vf.write(path, '\n'.join(x[1:] for x in lines) + '\n')
        elif kind == 'Delete':
            raise ValueError('Delete file operation not implemented')
        else:
            text = vf.read(path)
            hunks = []
            for line in lines:
                if line.startswith('@@'):
                    hunks.append({'header': line[2:].strip(), 'lines': []})
                else:
                    assert line[:1] in (' ', '+', '-'), line
                    hunks[-1]['lines'].append(line)
            cursor = 0
            for h in hunks:
                oldlines = [x[1:] for x in h['lines'] if x[:1] in (' ', '-')]
                newlines = [x[1:] for x in h['lines'] if x[:1] in (' ', '+')]
                old = '\n'.join(oldlines) + ('\n' if oldlines else '')
                new = '\n'.join(newlines) + ('\n' if newlines else '')
                found = re.compile('^' + re.escape(old), re.M).search(text, cursor)
                if not found:
                    raise ValueError('Patch context absent: ' + old[:100])
                start = found.start()
                text = text[:start] + new + text[start + len(old):]
                cursor = start + len(new)
            vf.write(path, text)


def run_codex(cell, emb, sources):
    task, arm = cell.rsplit('-', 1)
    vf = VirtualFiles(TASKS[task], cell)
    actions, problems = [], []
    for source in sorted(sources):
        rows = subprocess.check_output(['rtk', 'proxy', 'zstd', '-dc', str(source)]).decode().split('\n')
        for row, raw in enumerate(rows, 1):
            if not raw:
                continue
            payload = json.loads(raw).get('payload', {})
            if payload.get('type') not in ('custom_tool_call', 'function_call'):
                continue
            code = payload.get('input', payload.get('arguments', ''))
            provenance = {'source': str(source), 'sourceSha256': sha(source.read_bytes()), 'sourceRow': row, 'sourceRowUtf8Sha256': sha(raw.encode()), 'toolId': payload.get('call_id')}
            operations = []
            try:
                calls = []
                if payload.get('name', '').split('.')[-1] == 'apply_patch' and isinstance(code, str) and code.startswith('*** Begin Patch'):
                    calls.append((0, 'patch', code))
                else:
                    for match in re.finditer(r'tools\.apply_patch\(("(?:[^"\\]|\\.)*")\)', code, re.S):
                        calls.append((match.start(), 'patch', json.loads(match.group(1))))
                    for match in re.finditer(r'(?:"cmd"|cmd)\s*:\s*("(?:[^"\\]|\\.)*")', code, re.S):
                        calls.append((match.start(), 'shell-text', json.loads(match.group(1))))
                for _, kind, data in sorted(calls):
                    if kind == 'patch':
                        context_patch(data, vf)
                        operations.append({'kind': 'apply_patch', 'payload': data})
                    else:
                        operations.extend(shell_text_operations(data, vf))
                if operations:
                    actions.append({**provenance, 'operations': operations})
            except Exception as e:
                problems.append({**provenance, 'reason': type(e).__name__ + ': ' + str(e)[:500], 'code': code})
    patch, files, match, normhash = emit(vf, emb.get(task, {}))
    result = {'cell': cell, 'parentCommit': vf.task['parentSha'], 'sourceFiles': [{'source': str(s), 'sha256': sha(s.read_bytes())} for s in sources], 'actions': actions, 'problems': problems, 'candidateFiles': files, 'normalizedDiffSha256': normhash, 'fullOriginalJudgeEmbeddingMatches': match is not None, 'matchedJudgeSources': match['sources'] if match else [], 'status': 'verified-transcript-reconstruction' if match else 'blocked-reconstruction-does-not-match-original-judge-input'}
    if match:
        dest = HERE / 'transcript-reconstruction' / arm / (cell + '-transcript-reconstructed.patch')
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(patch)
        parsed = subprocess.run(['rtk', 'proxy', 'git', 'apply', '--numstat', str(dest)], capture_output=True, text=True)
        result.update({'patchPath': str(dest.relative_to(ROOT)), 'patchSha256': sha(patch.encode()), 'patchBytes': len(patch.encode()), 'gitApplyNumstat': {'exitCode': parsed.returncode, 'stdout': parsed.stdout, 'stderr': parsed.stderr}})
    return result


def main():
    emb = embeddings()
    results = []
    for arm in ('A', 'D'):
        for task in TASKS:
            if task == 'AIO-01':
                continue
            result = run_claude(task + '-' + arm, emb)
            results.append(result)
            print(json.dumps({'cell': result['cell'], 'status': result['status'], 'actions': len(result['actions']), 'problems': [(x['sourceRow'], x['reason']) for x in result['problems']]}), flush=True)
    codex = collections.defaultdict(list)
    for day in ('15', '16'):
        for source in Path('/Users/suas/.codex/sessions/2026/10/' + day).glob('*.jsonl.zst'):
            p = subprocess.Popen(['rtk', 'proxy', 'zstd', '-dc', str(source)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            first = p.stdout.readline()
            p.stdout.close()
            p.wait()
            meta = json.loads(first).get('payload', {})
            match = re.search(r'/([^/]+-G)-1$', meta.get('cwd', ''))
            if match:
                codex[match.group(1)].append(source)
    for task in TASKS:
        if task == 'AIO-01':
            continue
        result = run_codex(task + '-G', emb, codex[task + '-G'])
        results.append(result)
        print(json.dumps({'cell': result['cell'], 'status': result['status'], 'actions': len(result['actions']), 'problems': [(x['sourceRow'], x['reason']) for x in result['problems']]}), flush=True)
    (HERE / 'remaining-transcript-reconstruction.receipt.json').write_text(json.dumps({'method': 'Virtual files and AST-guarded captured Python text edits, exact Edit/Write payloads, captured cat heredocs and isolated sed programs with stdin only. No historical shell command executed. Full original judge-input equality is required before emitting a usable patch.', 'results': results}, indent=2) + '\n')


if __name__ == '__main__':
    main()
