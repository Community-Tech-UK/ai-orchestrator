"""Replay captured text operations only; never execute historical shell commands."""
import ast
import hashlib
import json
from pathlib import Path
import re
import subprocess
import shutil

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
PARENT = 'f04f674859b220b86eeb52662129072008573af9'


def command(*args):
    return subprocess.check_output(['rtk', 'proxy', *args])


def digest(data):
    return hashlib.sha256(data).hexdigest()


def base(rel):
    return command('git', 'show', f'{PARENT}:{rel}').decode()


def apply_context_patch(payload, files):
    lines = payload.splitlines()
    header = lines[1]
    rel = header.split('/AIO-01-G-1/', 1)[1]
    if header.startswith('*** Add File: '):
        assert rel not in files
        files[rel] = '\n'.join(line[1:] for line in lines[2:-1]) + '\n'
        return
    value = files.setdefault(rel, base(rel))
    hunks = []
    for line in lines[2:-1]:
        if line.startswith('@@'):
            hunks.append([])
        else:
            assert line[:1] in (' ', '+', '-')
            hunks[-1].append(line)
    for hunk in hunks:
        old = '\n'.join(x[1:] for x in hunk if x[:1] in (' ', '-')) + '\n'
        new = '\n'.join(x[1:] for x in hunk if x[:1] in (' ', '+')) + '\n'
        assert value.count(old) == 1, (rel, old)
        value = value.replace(old, new, 1)
    files[rel] = value


def replay_python(script, directory, files):
    """Interpret only the string-edit AST forms actually present in these scripts."""
    env = {}

    def path(name):
        return f'{directory}/{name}' if not name.startswith('src/') else name

    def value(node):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return env[node.id]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            return -value(node.operand)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return value(node.left) + value(node.right)
        if isinstance(node, ast.Slice):
            return slice(value(node.lower) if node.lower else None,
                         value(node.upper) if node.upper else None,
                         value(node.step) if node.step else None)
        if isinstance(node, ast.Subscript):
            return value(node.value)[value(node.slice)]
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            attr = node.func.attr
            target = node.func.value
            if isinstance(target, ast.Call) and isinstance(target.func, ast.Name) and target.func.id == 'open':
                rel = path(value(target.args[0]))
                if attr == 'read':
                    assert len(target.args) == 1 and not node.args
                    return files.setdefault(rel, base(rel))
                if attr == 'write':
                    assert len(target.args) == 2 and value(target.args[1]) == 'w'
                    files[rel] = value(node.args[0])
                    return len(files[rel])
            assert attr in ('rstrip', 'replace', 'index'), attr
            obj = value(target)
            assert isinstance(obj, str)
            args = [value(x) for x in node.args]
            if attr == 'replace':
                assert args[0] in obj, ('replace target missing', args[0])
            return getattr(obj, attr)(*args)
        raise AssertionError(ast.dump(node))

    for statement in ast.parse(script).body:
        if isinstance(statement, ast.Assign):
            assert len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name)
            env[statement.targets[0].id] = value(statement.value)
        elif isinstance(statement, ast.AugAssign):
            assert isinstance(statement.target, ast.Name) and isinstance(statement.op, ast.Add)
            env[statement.target.id] += value(statement.value)
        elif isinstance(statement, ast.Expr):
            value(statement.value)
        else:
            raise AssertionError(ast.dump(statement))


def claude_actions(source, arm, files):
    seen = set()
    actions = []
    for row, raw in enumerate(source.read_text().splitlines(), 1):
        entry = json.loads(raw)
        content = entry.get('message', {}).get('content', [])
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict) or item.get('type') != 'tool_use' or item.get('id') in seen:
                continue
            seen.add(item['id'])
            inp = item.get('input', {})
            action = None
            if arm == 'A' and item.get('name') == 'Edit':
                rel = inp['file_path'].split('/AIO-01-A-1/', 1)[1]
                current = files.setdefault(rel, base(rel))
                assert current.count(inp['old_string']) == 1
                files[rel] = current.replace(inp['old_string'], inp['new_string'], 1)
                action = {'kind': 'Edit', 'input': inp}
            if arm == 'D':
                cmd = inp.get('command', '')
                match = re.search(r"python3 - <<'E'\n(.*?)\nE(?:\n|$)", cmd, re.S)
                if match:
                    directory = 'src/main/history' if 'cd /private/tmp/plan-execute-ab/AIO-01-D-1/src/main/history;' in cmd else ''
                    replay_python(match[1], directory, files)
                    action = {'kind': 'restricted-python-text-edits', 'directory': directory, 'script': match[1]}
            if action:
                actions.append({'sourceRow': row, 'sourceRowUtf8Sha256': digest(raw.encode()), 'toolId': item['id'], **action})
    return actions


def emit(arm, files, actions, source):
    artifacts = []
    patches = []
    directory = HERE / 'transcript-reconstruction' / arm
    for rel, text in sorted(files.items()):
        candidate = directory / 'candidate' / (rel + '.txt')
        candidate.parent.mkdir(parents=True, exist_ok=True)
        candidate.write_text(text)
        exists = subprocess.run(['rtk', 'proxy', 'git', 'cat-file', '-e', f'{PARENT}:{rel}'], capture_output=True).returncode == 0
        original = directory / 'parent' / (rel + '.txt')
        if exists:
            original.parent.mkdir(parents=True, exist_ok=True)
            original.write_text(base(rel))
            oldarg = str(original)
        else:
            oldarg = '/dev/null'
        proc = subprocess.run(['rtk', 'proxy', 'git', 'diff', '--no-index', '--abbrev=7', '--', oldarg, str(candidate)], capture_output=True, text=True)
        assert proc.returncode in (0, 1), proc.stderr
        diff = proc.stdout
        if exists:
            diff = diff.replace('a/' + str(original).lstrip('/'), 'a/' + rel)
        else:
            diff = diff.replace('a/' + str(candidate).lstrip('/'), 'a/' + rel)
        diff = diff.replace('b/' + str(candidate).lstrip('/'), 'b/' + rel)
        patches.append(diff)
        artifacts.append({'sourcePath': rel, 'sha256': digest(text.encode()), 'bytes': len(text.encode()), 'newFile': not exists})
    patch = ''.join(patches)
    patchfile = directory / f'AIO-01-{arm}-transcript-reconstructed.patch'
    patchfile.write_text(patch)
    normalized = '\n'.join(line for line in patch.split('\n') if line.strip())
    embedding = (HERE / f'AIO-01-{arm}-full-judge-embedding.txt').read_text()
    syntax = subprocess.run(['rtk', 'proxy', 'git', 'apply', '--numstat', str(patchfile)], capture_output=True, text=True)
    for temporary_tree in [directory / 'candidate', directory / 'parent']:
        if temporary_tree.exists():
            shutil.rmtree(temporary_tree)
    return {'arm': arm, 'classification': 'Deterministic replay of captured source edits against known parent; regenerated diff, not recovered original runner patch.',
            'source': str(source), 'sourceSha256': digest(source.read_bytes()), 'parentCommit': PARENT, 'actions': actions,
            'candidateFiles': artifacts, 'patchPath': str(patchfile.relative_to(ROOT)), 'patchSha256': digest(patch.encode()),
            'patchBytes': len(patch.encode()), 'gitApplyNumstat': {'exitCode': syntax.returncode, 'stdout': syntax.stdout, 'stderr': syntax.stderr},
            'blankLineStrippedDiffExactlyMatchesOriginalJudgeEmbedding': normalized == embedding,
            'normalizedDiffSha256': digest(normalized.encode()), 'originalJudgeEmbeddingSha256': digest(embedding.encode()),
            'limitations': ['No historical shell commands executed. Temporary stash/check/pop cycles are omitted as net no-ops; final judge-input equality checks the resulting full diff.',
                           'No original runner patch hash survives for direct byte comparison. Reconstructed source and regenerated patch are not labelled original.']}


def main():
    results = []
    for arm, filename in [('A', 'f8d40317-469c-46e3-a31c-da425dd05f8c.jsonl'), ('D', 'ae7f6bab-a813-46aa-a54e-1d472eb7542a.jsonl')]:
        source = Path(f'/Users/suas/.claude/projects/-private-tmp-plan-execute-ab-AIO-01-{arm}-1') / filename
        files = {}
        actions = claude_actions(source, arm, files)
        results.append(emit(arm, files, actions, source))
    source = Path(json.loads((HERE / 'codex-location.receipt.json').read_text())['hits'][0])
    rows = command('zstd', '-dc', str(source)).decode().splitlines()
    files = {}
    actions = []
    for row, raw in enumerate(rows, 1):
        payload = json.loads(raw).get('payload', {})
        if payload.get('type') != 'custom_tool_call':
            continue
        match = re.search(r'tools\.apply_patch\(("(?:[^"\\]|\\.)*")\)', payload.get('input', ''), re.S)
        if match:
            patch = json.loads(match[1])
            apply_context_patch(patch, files)
            actions.append({'sourceRow': row, 'sourceRowUtf8Sha256': digest(raw.encode()), 'toolId': payload['call_id'], 'kind': 'apply_patch', 'patch': patch})
    results.append(emit('G', files, actions, source))
    receipt = {'parentCommit': PARENT, 'provenance': 'Parent selected from AIO-01 task-bank entry and runner exportWorkspace(task.parentSha); source tool rows retained by hash and complete edit payload.', 'results': results}
    (HERE / 'aio01-transcript-reconstruction.receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps([{'arm': r['arm'], 'actions': len(r['actions']), 'files': len(r['candidateFiles']), 'patchParses': r['gitApplyNumstat']['exitCode'] == 0, 'judgeEmbeddingMatches': r['blankLineStrippedDiffExactlyMatchesOriginalJudgeEmbedding']} for r in results]))


if __name__ == '__main__':
    main()
