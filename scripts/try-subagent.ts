import { createApp } from '/root/.openclaw/workspace/projects/friend-agent/src/app.ts';

const app = createApp();

const kind = process.argv[2] ?? 'general';
const prompt = process.argv[3] ?? '在当前工作目录下创建 hello.txt，内容写 hello，然后列出目录确认文件已存在。';

console.log(`[test] kind=${kind}`);
console.log(`[test] prompt=${prompt}`);

const done = new Promise<any>((resolve) => {
  app.orch.onEvent((e) => {
    if (e.kind === 'accepted') { console.log(`[accepted] taskId=${e.taskId}`); return; }
    if (e.kind === 'progress') { console.log(`  [进度 ${e.progress}%] ${e.text}`); return; }
    if (e.kind === 'tool') {
      console.log(`  [工具${e.isError ? '✗' : '·'}] ${e.name} ${e.args ? 'args=' + String(e.args).slice(0, 80) : ''} ${e.result ? '→ ' + String(e.result).replace(/\n/g, ' ').slice(0, 120) : ''}`);
      return;
    }
    console.log(`[done] ${e.text}`);
    resolve(e);
  });
});

app.orch.dispatch({
  personId: 'p_test',
  origin: { personId: 'p_test', channel: 'qq', externalId: '10001' },
  prompt,
  kind,
});

await Promise.race([done, new Promise((r) => setTimeout(r, 180_000))]);
setTimeout(() => process.exit(0), 500);
