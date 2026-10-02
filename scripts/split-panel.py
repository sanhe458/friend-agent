"""把 panel.html 里的内联脚本按页面边界切成 shell.js + pages/*.js（机械切分，不手抄）。"""
import re
from pathlib import Path

root = Path('src/panel')
html_path = root / 'panel.html'
h = html_path.read_text()

m = re.search(r'<script>\n(.*?)\n</script>', h, re.S)
if not m:
    raise SystemExit('没找到内联 script')
body = m.group(1)
lines = body.split('\n')

def find(marker: str, start: int = 0) -> int:
    for i in range(start, len(lines)):
        if lines[i].strip() == marker or lines[i].startswith(marker):
            return i
    raise SystemExit(f'找不到标记: {marker}')

# 各页面切片的起止标记（都取“下一个页面函数”作为上界）
PAGES = [
    ('overview', 'function renderOverview(v) {', 'function renderRuntime(v) {'),
    ('runtime',  'function renderRuntime(v) {',  'function renderTasks(v) {'),
    ('tasks',    'function renderTasks(v) {',    'function renderPersons(v) {'),
    ('persons',  'function renderPersons(v) {',  'async function renderMemory(v) {'),
    ('memory',   'async function renderMemory(v) {', 'function renderChannels(v) {'),
    ('channels', 'function renderChannels(v) {', 'async function renderModels(v) {'),
    ('models',   'async function renderModels(v) {', 'async function renderRoles(v) {'),
    ('roles',    'async function renderRoles(v) {', 'function renderTools(v) {'),
    ('tools',    'function renderTools(v) {',    "let logFilter = 'all';"),
    ('logs',     "let logFilter = 'all';",       'function renderSearch(v) {'),
    ('search',   'function renderSearch(v) {',   "let chatCh = 'qq', chatId = '';"),
    ('chat',     "let chatCh = 'qq', chatId = '';", 'async function refresh() {'),
]

head_end = find('function renderOverview(v) {')
tail_start = find('async function refresh() {')

out_dir = root / 'public'
(out_dir / 'pages').mkdir(parents=True, exist_ok=True)

# ── 各页面文件 ──
for pid, start_m, end_m in PAGES:
    s = find(start_m)
    e = find(end_m, s + 1)
    code = '\n'.join(lines[s:e]).rstrip()
    # 页面里第一个顶层函数名，用于注册
    fn = re.search(r'^(?:async )?function (\w+)', code, re.M)
    reg = f"\n\nPAGES[{pid!r}] = {{ render: {fn.group(1)} }};\n" if fn else '\n'
    (out_dir / 'pages' / f'{pid}.js').write_text(
        f"/* 页面：{pid} */\n{code}{reg}"
    )
    print(f'  pages/{pid}.js  ({len(code)} 字节)')

# ── shell.js = 头部 + 尾部，并把 render() 换成注册表派发 ──
head = '\n'.join(lines[:head_end]).rstrip()
tail = '\n'.join(lines[tail_start:]).rstrip()

old_render = re.search(r'function render\(\) \{.*?\n\}', head, re.S)
if not old_render:
    raise SystemExit('没找到 render() 以便替换')
new_render = """const PAGES = {};

/* 路由：按页面 id 从注册表派发（新增页面 = 新增一个 pages/<id>.js） */
function render() {
  const v = $('#view');
  const t = $('#tacts');
  if (t) t.innerHTML = '';
  const pg = PAGES[TAB];
  if (pg && typeof pg.render === 'function') return pg.render(v);
  v.innerHTML = '<div class="empty">页面「' + esc(TAB) + '」还没实现</div>';
}"""
head = head[:old_render.start()] + new_render + head[old_render.end():]

(out_dir / 'shell.js').write_text(
    "/* 面板外壳：工具函数 / 路由 / 导航 / 弹窗 / 快照刷新 */\n" + head + '\n\n' + tail + '\n'
)
print(f'  shell.js  ({len(head) + len(tail)} 字节)')

# ── panel.html 改成引用外部脚本，顺序：shell 先，页面后 ──
order = [p[0] for p in PAGES]
tags = '\n'.join(
    ['<script src="/panel/shell.js"></script>']
    + [f'<script src="/panel/pages/{p}.js"></script>' for p in order]
)
h = h[:m.start()] + tags + h[m.end():]
html_path.write_text(h)
print(f'  panel.html 现在是 {len(h)} 字节')
