#!/usr/bin/env bash
# 身份归并流程自检：每个对话自动建档 → 跨对话验证 → 自动合并
set -u
cd "$(dirname "$0")/.."
T=$(python3 -c "import json;print(json.load(open('config.local.json')).get('panelToken',''))")
B="http://127.0.0.1:8918"
H=(-H "x-panel-token: $T" -H 'Content-Type: application/json')

post() { curl -s -X POST "${H[@]}" -d "$2" "$B$1"; }

echo "=== ① 两个不同的对话各发一句话（应各自自动建档）==="
post /api/say '{"channel":"panel","externalId":"convA","text":"我是甲"}' >/dev/null
post /api/say '{"channel":"telegram","externalId":"convB","text":"我是乙"}' >/dev/null
sleep 1
curl -s "${H[@]}" "$B/api/state" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ps=[p for p in d['persons'] if any(b['externalId'] in ('convA','convB') for b in p['bindings'])]
print('  相关档案数:', len(ps), '（期望 2 —— 每个对话一份）')
for p in ps: print('   ', p['id'], p['displayName'], [b['channel']+':'+b['externalId'] for b in p['bindings']])
"

echo "=== ② 发起归并（码发到 panel:convA，要在 telegram:convB 里回）==="
REQ=$(post /api/merge/request '{"from":{"channel":"telegram","externalId":"convB"},"claim":{"channel":"panel","externalId":"convA"}}')
echo "  $REQ"
CODE=$(printf '%s' "$REQ" | python3 -c "import sys,json;print(json.load(sys.stdin).get('code',''))")

echo "=== ③ 在【错误的一边】(panel:convA) 回码 —— 应被拒 ==="
post /api/merge/confirm "{\"code\":\"$CODE\",\"via\":{\"channel\":\"panel\",\"externalId\":\"convA\"}}"
echo

echo "=== ④ 在【发起方】(telegram:convB) 回码 —— 应自动合并 ==="
curl -s -X POST "${H[@]}" -d "{\"code\":\"$CODE\",\"via\":{\"channel\":\"telegram\",\"externalId\":\"convB\"}}" "$B/api/merge/confirm" | head -c 260
echo
curl -s "${H[@]}" "$B/api/state" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ps=[p for p in d['persons'] if any(b['externalId'] in ('convA','convB') for b in p['bindings'])]
print('  合并后相关档案数:', len(ps), '（期望 1）')
for p in ps: print('   ', p['id'], [b['channel']+':'+b['externalId'] for b in p['bindings']])
"

echo "=== ⑤ 入站钩子：直接把 6 位码当消息发出去，应自动合并 ==="
post /api/say '{"channel":"panel","externalId":"convC","text":"我是丙"}' >/dev/null
post /api/say '{"channel":"telegram","externalId":"convD","text":"我是丁"}' >/dev/null
sleep 1
R2=$(post /api/merge/request '{"from":{"channel":"telegram","externalId":"convD"},"claim":{"channel":"panel","externalId":"convC"}}')
C2=$(printf '%s' "$R2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('code',''))")
echo "  验证码 $C2，现在把它当普通消息发到 telegram:convD"
post /api/say "{\"channel\":\"telegram\",\"externalId\":\"convD\",\"text\":\"$C2\"}" >/dev/null
sleep 2
curl -s "${H[@]}" "$B/api/state" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ps=[p for p in d['persons'] if any(b['externalId'] in ('convC','convD') for b in p['bindings'])]
print('  自动合并后相关档案数:', len(ps), '（期望 1）')
for p in ps: print('   ', p['id'], [b['channel']+':'+b['externalId'] for b in p['bindings']])
print('  --- 身份日志 ---')
for e in [x for x in d['log'] if '身份' in x['text']][-3:]: print('   ', e['text'][:110])
print('  --- 出站（应有“这两个对话是你同一个人”）---')
for e in [x for x in d['log'] if x['dir']=='out' and '同一个人' in x['text']][-2:]: print('   ', e.get('channel'), '→', str(e.get('to'))[:12], '|', e['text'][:40])
"
