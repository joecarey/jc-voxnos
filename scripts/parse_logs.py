#!/usr/bin/env python3
"""Parse FreeClimb call logs into a human-readable timeline."""
import json, sys, re

data = json.load(sys.stdin)
logs = data.get('logs', [])

if not logs:
    print('No logs found.')
    sys.exit(0)

call_id = sys.argv[1] if len(sys.argv) > 1 else ''
if not call_id:
    call_id = logs[0].get('callId', '')
    print(f'Most recent call: {call_id}')

call_logs = [l for l in logs if l.get('callId') == call_id]
call_logs.sort(key=lambda x: x['timestamp'])

if not call_logs:
    print(f'No logs for callId={call_id}')
    sys.exit(0)

t0 = call_logs[0]['timestamp'] // 1_000_000
print(f'Call: {call_id}  ({len(call_logs)} events)')
print('-' * 80)

for l in call_logs:
    ts = l['timestamp'] // 1_000_000
    offset = ts - t0
    meta = l.get('metadata', {})
    body = meta.get('requestBody', {})
    resp = meta.get('responseBody', '')

    parts = [f'+{offset:>4}s']

    if 'transcript' in body:
        reason = body.get('transcribeReason', '?')
        transcript = body.get('transcript', '')
        parts.append(f'SPEECH  reason={reason}  "{transcript}"')
    elif body.get('requestType') == 'inboundCall':
        parts.append(f'CALL    from={body.get("from","?")} to={body.get("to","?")}')
    elif body.get('requestType') == 'redirect':
        url = meta.get('requestHeaders', {}).get('url', [''])[0]
        n_match = re.search(r'[&?]n=(\d+)', url)
        n_val = n_match.group(1) if n_match else '?'
        parts.append(f'REDIR   n={n_val}')
    elif resp:
        parts.append('RESP')
    else:
        parts.append('EVENT')

    if resp:
        try:
            cmds = json.loads(resp)
            cmd_names = []
            for cmd in cmds:
                for k in cmd:
                    if k == 'Play':
                        file_url = cmd[k].get('file', '')
                        id_match = re.search(r'id=([^&]+)', file_url)
                        play_id = id_match.group(1) if id_match else '?'
                        cmd_names.append(f'Play({play_id[:24]})')
                    elif k == 'TranscribeUtterance':
                        cmd_names.append('Listen')
                    elif k == 'Redirect':
                        action = cmd[k].get('actionUrl', '')
                        n_match2 = re.search(r'[&?]n=(\d+)', action)
                        cmd_names.append(f'Redirect(n={n_match2.group(1) if n_match2 else "?"})')
                    else:
                        cmd_names.append(k)
            parts.append(' -> ' + ' + '.join(cmd_names))
        except Exception:
            parts.append(f' -> {resp[:80]}')

    print('  '.join(parts))
