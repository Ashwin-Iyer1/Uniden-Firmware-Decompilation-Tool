#!/usr/bin/env python3
"""Interactive stdio REA MCP client; retain complete results locally.

Use when a running host MCP connection predates a Ghidra environment change.
Reads JSON lines {"name": TOOL, "arguments": {...}, "tag": FILE_STEM}.
No target code is executed by this client. Tool effects follow the chosen tool.
Ghidra and REA must already be installed; defaults match the pinned REA version.
"""
import argparse
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', type=Path, default=Path('decoded/rea/session'))
    ap.add_argument('--ghidra', default=os.environ.get('GHIDRA_INSTALL_DIR'))
    ap.add_argument('--java-home', default=os.environ.get('JAVA_HOME'))
    ap.add_argument('--language', default='ARM:LE:32:Cortex')
    ap.add_argument('--timeout', type=float, default=600,
                    help='deadline per MCP request in seconds')
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.timeout <= 0:
        ap.error('--timeout must be positive')
    for filename in ('initialize.json', 'tools.json'):
        if (args.out / filename).exists():
            ap.error(f'{args.out} contains an earlier session; choose a new --out directory')
    env = dict(os.environ)
    if args.ghidra:
        env['GHIDRA_INSTALL_DIR'] = args.ghidra
    if args.java_home:
        env['JAVA_HOME'] = args.java_home
    env['REA_GHIDRA_LANGUAGE_ID'] = args.language
    env['REA_GHIDRA_COMPILER_SPEC_ID'] = 'default'
    log = (args.out / 'server.stderr.log').open('a')
    proc = subprocess.Popen(['npx', '-y', 'rea-agents@6.5.0', 'mcp'],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=log, env=env, start_new_session=True)
    counter = 0
    buffered = b''

    def send(message):
        proc.stdin.write((json.dumps(message) + '\n').encode())
        proc.stdin.flush()

    def rpc(method, params):
        nonlocal counter, buffered
        counter += 1
        send({'jsonrpc': '2.0', 'id': counter, 'method': method, 'params': params})
        deadline = time.monotonic() + args.timeout
        while True:
            while b'\n' not in buffered:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([proc.stdout], [], [], remaining)[0]:
                    raise TimeoutError(f'MCP {method} exceeded {args.timeout} seconds; no automatic retry')
                chunk = os.read(proc.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError(f'REA exited ({proc.poll()}); inspect server.stderr.log')
                buffered += chunk
            line, buffered = buffered.split(b'\n', 1)
            value = json.loads(line)
            if value.get('id') == counter:
                if 'error' in value:
                    raise RuntimeError(value['error'])
                return value['result']
            if 'method' in value and 'id' in value:
                send({'jsonrpc': '2.0', 'id': value['id'], 'error':
                      {'code': -32601, 'message': 'Client method unsupported'}})

    try:
        init = rpc('initialize', {'protocolVersion': '2025-03-26',
                   'capabilities': {}, 'clientInfo': {'name': 'r7-analysis', 'version': '1'}})
        send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        with (args.out / 'initialize.json').open('x') as handle:
            json.dump(init, handle, indent=2)
        catalog = rpc('tools/list', {})
        with (args.out / 'tools.json').open('x') as handle:
            json.dump(catalog, handle, indent=2)
        names = {t['name'] for t in catalog['tools']}
        print(json.dumps({'ready': True, 'server': init.get('serverInfo'), 'tools': len(names)}), flush=True)
        for line in sys.stdin:
            if not line.strip():
                continue
            request = json.loads(line)
            if request.get('quit'):
                break
            name = request['name']
            if name not in names:
                print(json.dumps({'error': 'Tool absent from server catalog', 'name': name}), flush=True)
                continue
            tag = request.get('tag', f'{counter:04d}_{name}')
            if not tag or Path(tag).name != tag or tag in ('.', '..'):
                raise ValueError('tag must be a plain filename stem')
            dest = args.out / (tag + '.json')
            # Reserve before calling: a collision must never execute a tool and
            # then discard its result. Failure records explicitly retain uncertainty.
            with dest.open('x') as handle:
                try:
                    result = rpc('tools/call', {'name': name, 'arguments': request.get('arguments', {})})
                    json.dump(result, handle, indent=2)
                    handle.write('\n')
                except Exception as exc:
                    json.dump({'client_error': str(exc), 'request': request,
                               'completion_status': 'unknown'}, handle, indent=2)
                    raise
            summary = {'tool': name, 'path': str(dest), 'isError': result.get('isError', False)}
            structured = result.get('structuredContent', {})
            summary['evidence_id'] = structured.get('evidence_id')
            if result.get('isError'):
                summary['error'] = str(result.get('content'))[:600]
            print(json.dumps(summary), flush=True)
    finally:
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        log.close()


if __name__ == '__main__':
    main()
