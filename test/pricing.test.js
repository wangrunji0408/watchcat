const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  decorateOpenClawSummary,
  detailClaude,
  detailOpenClaw,
  normalizeModelName,
  normalizedUsage,
  priceForModel,
  summarizeClaude,
  summarizeOpenClaw,
  summarizeUsageRecords,
} = require('../server');

test('normalizes provider and dated model aliases', () => {
  assert.equal(normalizeModelName('openai/gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(normalizeModelName('azure-gpt-5.4-2026-03-05'), 'gpt-5.4');
  assert.equal(priceForModel('anthropic/claude-opus-4-8').input, 5);
});

test('prices Codex uncached, cached, and output tokens separately', () => {
  const usage = normalizedUsage({
    input_tokens: 19_000,
    cached_input_tokens: 9_984,
    output_tokens: 314,
    total_tokens: 19_314,
  }, 'codex');
  const result = summarizeUsageRecords([{ model: 'gpt-5.6-sol', usage }]);

  assert.equal(usage.inputTokens, 9_016);
  assert.equal(usage.cachedInputTokens, 9_984);
  assert.equal(result.cost.usd, 0.059492);
  assert.equal(result.cost.complete, true);
});

test('uses long-context prices above 272K input tokens', () => {
  const usage = normalizedUsage({ input_tokens: 300_000, output_tokens: 1_000 }, 'codex');
  const result = summarizeUsageRecords([{ model: 'gpt-5.4', usage }]);

  assert.equal(result.cost.usd, 1.5225);
});

test('deduplicates repeated Claude log entries by message id', () => {
  const user = { type: 'user', message: { content: 'hello' }, timestamp: '2026-07-17T00:00:00Z' };
  const assistant = {
    type: 'assistant',
    timestamp: '2026-07-17T00:00:01Z',
    message: {
      id: 'msg-1',
      model: 'claude-fable-5',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 10 },
    },
  };
  const summary = summarizeClaude('/tmp/session.jsonl', { size: 1 },
    [user, assistant, { ...assistant, uuid: 'duplicate-row' }].map(JSON.stringify).join('\n'));

  assert.equal(summary.model, 'claude-fable-5');
  assert.equal(summary.usage.requests, 1);
  assert.equal(summary.usage.totalTokens, 310);
  assert.equal(summary.cost.usd, 0.0017);
});

test('marks models without an official catalog price as unknown', () => {
  const usage = normalizedUsage({ input_tokens: 1_000, output_tokens: 100 }, 'claude');
  const result = summarizeUsageRecords([{ model: 'unknown-model-v1', usage }]);

  assert.equal(result.cost.usd, null);
  assert.deepEqual(result.cost.unknownModels, ['unknown-model-v1']);
});

test('parses OpenClaw messages, tools, usage, and subagent metadata', () => {
  const file = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions',
    '11111111-1111-4111-8111-111111111111.jsonl');
  const rows = [
    { type: 'session', version: 3, id: 'session-1', timestamp: '2026-07-18T00:00:00Z', cwd: '/tmp/project' },
    { type: 'model_change', timestamp: '2026-07-18T00:00:01Z', provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    { type: 'message', timestamp: '2026-07-18T00:00:02Z', message: { role: 'user', content: 'build it' } },
    { type: 'message', timestamp: '2026-07-18T00:00:03Z', message: {
      role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4-5',
      content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.txt' } },
      ],
      usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 30, totalTokens: 65 },
    } },
    { type: 'message', timestamp: '2026-07-18T00:00:04Z', message: {
      role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'contents' }],
    } },
    { type: 'message', timestamp: '2026-07-18T00:00:05Z', message: {
      role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'done' }],
      usage: { input: 11, output: 6, cacheRead: 21, cacheWrite: 31, totalTokens: 69 },
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const raw = summarizeOpenClaw(file, { size: content.length }, content);
  const summary = decorateOpenClawSummary(raw, {
    agentId: 'main', sessionKey: 'agent:main:subagent:child-1', label: 'worker',
    parentSessionKey: 'agent:main:main', parentSessionId: 'parent-1', status: 'done',
  });

  assert.equal(summary.project, '/tmp/project');
  assert.equal(summary.title, 'worker');
  assert.equal(summary.sessionKind, 'subagent');
  assert.equal(summary.parentSessionId, 'parent-1');
  assert.equal(summary.turns, 3);
  assert.equal(summary.usage.inputTokens, 21);
  assert.equal(summary.usage.cachedInputTokens, 41);
  assert.equal(summary.usage.cacheWriteTokens, 61);
  assert.equal(summary.contextTokens, 69);

  const detail = detailOpenClaw(file, content);
  assert.deepEqual(detail.map(m => m.role), ['user', 'thinking', 'tool_use', 'tool_result', 'assistant']);
  assert.equal(detail[2].callId, 'call-1');
  assert.equal(detail[3].output, 'contents');
});

test('parses Claude Code sidechain rows when they are in a subagent transcript', () => {
  const file = '/tmp/project/parent-session/subagents/agent-worker-1.jsonl';
  const rows = [
    { type: 'user', isSidechain: true, agentId: 'worker-1', sessionId: 'parent-session',
      cwd: '/tmp/project', timestamp: '2026-07-18T00:00:00Z', message: { content: 'inspect the code' } },
    { type: 'assistant', isSidechain: true, agentId: 'worker-1', sessionId: 'parent-session',
      cwd: '/tmp/project', timestamp: '2026-07-18T00:00:01Z', message: {
        id: 'msg-1', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'found it' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeClaude(file, { size: content.length }, content);

  assert.equal(summary.id, 'worker-1');
  assert.equal(summary.sessionKind, 'subagent');
  assert.equal(summary.parentSessionId, 'parent-session');
  assert.equal(summary.project, '/tmp/project');
  assert.equal(summary.turns, 2);
  assert.deepEqual(detailClaude(file, content).map(m => m.role), ['user', 'assistant']);
});
