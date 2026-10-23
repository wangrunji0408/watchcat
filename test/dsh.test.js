const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listDshSessionFiles, summarizeDsh, detailDsh, linkDshSubagents } = require('../server');

// Hand-written synthetic records only; never copy local session contents here.
const encode = rows => rows.map(JSON.stringify).join('\n');

test('discovers raw and compressed DSH logs and selects one newest generation per directory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchcat-dsh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = [
    'migrated/session.jsonl.zstd', 'migrated/session.v3.jsonl.zstd', 'migrated/session.v4.jsonl.zstd',
    'raw/session.v4.jsonl', 'raw/session.v4.jsonl.zstd', 'legacy/session.jsonl',
    'legacy-compressed/session.jsonl.zstd', 'numeric/session.v9.jsonl', 'numeric/session.v10.jsonl',
    'ignored/session.v0.jsonl', 'ignored/session.v04.jsonl', 'ignored/session.v4.jsonl.tmp',
    'ignored/other.jsonl.zstd',
  ];
  for (const name of names) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  assert.deepEqual(listDshSessionFiles(dir).map(file => path.relative(dir, file)).sort(), [
    'legacy-compressed/session.jsonl.zstd', 'legacy/session.jsonl',
    'migrated/session.v4.jsonl.zstd', 'numeric/session.v10.jsonl', 'raw/session.v4.jsonl',
  ]);
});

test('renders v4 direct tool results, preserves read contents and matches toolCallId', () => {
  const text = 'Synthetic source line\n'.repeat(50);
  const content = encode([
    { type: 'tool/call', data: { callId: 'read-1', name: 'read', arguments: '{"file_path":"/example/file.js"}' } },
    { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'read-1',
      source: { kind: 'tool' }, content: [{ type: 'text', text }] } } },
    { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'read-1',
      content: [{ type: 'text', text: 'duplicate delivery' }] } } },
    { type: 'tool/call', data: { callId: 'bash-1', name: 'bash', arguments: '{"command":"false"}' } },
    { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'bash-1', isError: true,
      content: [{ type: 'text', text: 'Command failed' }, { type: 'text', text: 'Exit code: 1' }] } } },
  ]);
  const detail = detailDsh('/example/session.v4.jsonl', content);
  assert.deepEqual(detail.map(m => m.role), ['tool_use', 'tool_result', 'tool_use', 'tool_result']);
  assert.equal(detail[1].toolName, 'read');
  assert.equal(detail[1].readContent, text);
  assert.equal(detail[3].toolName, 'bash');
  assert.equal(detail[3].output, 'Command failed Exit code: 1');
});

test('renders standalone goal changes and system messages without counting user turns', () => {
  const goal = { id: 'synthetic-goal', objective: 'Build an example', phase: 'active', maxGoalRounds: 10 };
  const rows = [
    { type: 'session', version: 4, id: 'synthetic-parent', cwd: '/example', createdAt: 1000 },
    { type: 'goal/change', time: 2000, data: { kind: 'goal/change', version: 1,
      operation: 'create', goal, roundsStarted: 0 } },
    { type: 'system/message', time: 3000, data: { message: {
      role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Synthetic policy' }] } } },
    { type: 'goal/change', time: 4000, data: { kind: 'goal/change', version: 1,
      operation: 'block', goal: { ...goal, phase: 'blocked', blockedReason: { message: 'Missing example' } }, roundsStarted: 3 } },
    { type: 'goal/change', time: 5000, data: { kind: 'goal/change', version: 1,
      operation: 'clear', cleared: { id: goal.id, revision: 3 }, clearedAt: 5000 } },
  ];
  const content = encode(rows);
  const summary = summarizeDsh('/example/session.v4.jsonl.zstd', {}, content);
  assert.equal(summary.title, goal.objective);
  assert.equal(summary.turns, 0);
  const detail = detailDsh('/example/session.v4.jsonl.zstd', content);
  assert.deepEqual(detail.map(m => m.role), ['goal', 'runtime_context', 'goal', 'goal']);
  assert.equal(detail[0].objective, goal.objective);
  assert.equal(detail[1].text, 'Synthetic policy');
  assert.equal(detail[2].round, 3);
  assert.equal(detail[2].reason, 'Missing example');
  assert.equal(detail[3].event, 'clear');
  assert.equal(detail[3].goalId, goal.id);
});

test('links catalogued subagents without relying on tool output text', () => {
  const parent = summarizeDsh('/example/parent/session.v4.jsonl', {}, encode([
    { type: 'session', version: 4, id: 'synthetic-parent' },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Review example' }] } },
    { type: 'subagent/catalog', data: { version: 0, childId: 'synthetic-child', label: 'Reviewer' } },
  ]));
  const child = summarizeDsh('/example/child/session.v4.jsonl', {}, encode([
    { type: 'session', version: 4, id: 'synthetic-child' },
    { type: 'subagent/descriptor', data: { label: 'Reviewer' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Reviewed' }] } } },
  ]));
  linkDshSubagents([parent, child]);
  assert.equal(child.parentFile, parent.file);
  assert.equal(child.agentId, child.id);
});
