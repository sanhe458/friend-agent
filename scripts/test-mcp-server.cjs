/**
 * 一个最小但**真实**的 MCP 服务器（stdio，标准 JSON-RPC）。
 * 用途：给 friend-agent 的 MCP 客户端做端到端测试（不假装，走完整 initialize/tools 握手）。
 *
 * 提供两个工具：
 *   echo  — 原样返回输入
 *   add   — 两数相加
 */
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const TOOLS = [
  {
    name: 'echo',
    description: '把输入原样返回（测试用）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: '两数相加（测试用）',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // 通知不回

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test-mcp', version: '1.0.0' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: a } = msg.params ?? {};
    if (name === 'echo') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo: ' + String(a?.text ?? '') }] } });
    else if (name === 'add') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'add: ' + (Number(a?.a) + Number(a?.b)) }] } });
    else send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '未知工具' }], isError: true } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } });
  }
});
