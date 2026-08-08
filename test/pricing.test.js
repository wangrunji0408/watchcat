const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  decorateOpenClawSummary,
  detailClaude,
  detailCodex,
  detailCetus,
  detailDsh,
  detailHermesRows,
  detailOpenClaw,
  extractThinkingEffort,
  includeSubagentCosts,
  linkCodexSubagents,
  normalizeModelName,
  normalizedUsage,
  priceForModel,
  summarizeClaude,
  summarizeCodex,
  summarizeCetus,
  summarizeDsh,
  summarizeOpenClaw,
  summarizeUsageRecords,
} = require('../server');

test('recursively includes subagent usage and cost in parent sessions', () => {
  const usage = (inputTokens) => ({ inputTokens, cachedInputTokens: 0, cacheWriteTokens: 0,
    cacheWrite1hTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: inputTokens, requests: 1 });
  const sessions = [
    { file: '/parent', sessionKind: 'agent', models: ['parent-model'], usage: usage(100),
      cost: { usd: 1, complete: true, unknownModels: [] } },
    { file: '/child', parentFile: '/parent', sessionKind: 'subagent', models: ['child-model'], usage: usage(20),
      cost: { usd: .2, complete: true, unknownModels: [] } },
    { file: '/grandchild', parentFile: '/child', sessionKind: 'subagent', models: ['unknown-model'], usage: usage(3),
      cost: { usd: null, complete: false, unknownModels: ['unknown-model'] } },
  ];

  const [parent, child] = includeSubagentCosts(sessions);
  assert.equal(parent.usage.inputTokens, 123);
  assert.equal(parent.cost.usd, 1.2);
  assert.equal(parent.cost.complete, false);
  assert.deepEqual(parent.cost.unknownModels, ['unknown-model']);
  assert.equal(parent.subagentCount, 2);
  assert.equal(parent.subagentCost.usd, .2);
  assert.deepEqual(parent.models, ['parent-model', 'child-model', 'unknown-model']);
  assert.equal(child.usage.inputTokens, 23);
  assert.equal(sessions[0].usage.inputTokens, 100);
});

test('renders Hermes file and terminal tool calls with paired results', () => {
  const rows = [
    { role: 'assistant', content: '', reasoning: null, timestamp: 1, tool_calls: JSON.stringify([
      { id: 'write-1', function: { name: 'write_file', arguments: JSON.stringify({ path: '/tmp/a.js', content: 'ok();' }) } },
      { id: 'term-1', function: { name: 'terminal', arguments: JSON.stringify({ command: 'npm test' }) } },
    ]) },
    { role: 'tool', content: JSON.stringify({ bytes_written: 5 }), tool_name: 'write_file',
      tool_call_id: 'write-1', timestamp: 2 },
    { role: 'tool', content: JSON.stringify({ output: 'tests passed\n', exit_code: 0 }), tool_name: 'terminal',
      tool_call_id: 'term-1', timestamp: 3 },
  ];

  const detail = detailHermesRows(rows);
  assert.deepEqual(detail[0].write, { path: '/tmp/a.js', content: 'ok();' });
  assert.deepEqual(detail[1].bash, { command: 'npm test' });
  assert.equal(detail[2].callId, 'write-1');
  assert.equal(detail[3].callId, 'term-1');
  assert.equal(detail[3].output, 'tests passed\n');
});

test('renders Hermes read_file and patch calls using structured views', () => {
  const rows = [
    { role: 'assistant', content: '', reasoning: null, timestamp: 1, tool_calls: JSON.stringify([
      { call_id: 'read-1', function: { name: 'read_file', arguments: '{"path":"README.md"}' } },
      { id: 'patch-1', function: { name: 'patch', arguments: JSON.stringify({
        path: 'README.md', old_string: 'old', new_string: 'new', mode: 'replace',
      }) } },
    ]) },
    { role: 'tool', content: JSON.stringify({ content: '# title\n' }), tool_name: 'read_file',
      tool_call_id: 'read-1', timestamp: 2 },
  ];

  const detail = detailHermesRows(rows);
  assert.deepEqual(detail[0].read, { path: 'README.md', offset: null, limit: null, pages: null });
  assert.deepEqual(detail[1].edit, { path: 'README.md', oldText: 'old', newText: 'new', replaceAll: false });
  assert.equal(detail[2].callId, 'read-1');
  assert.equal(detail[2].readContent, '# title\n');
});

test('renders Hermes context summaries as compaction events', () => {
  const prefix = '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below:';
  const rows = [
    { role: 'user', content: `${prefix}\n## Checkpoint\n\nContinue here.`, timestamp: 1 },
    { role: 'assistant', content: '[CONTEXT SUMMARY]: Legacy checkpoint', timestamp: 2 },
    { role: 'user', content: 'actual request', timestamp: 3 },
  ];

  const detail = detailHermesRows(rows);
  assert.deepEqual(detail.map(message => message.role), ['compaction', 'compaction', 'user']);
  assert.equal(detail[0].summary, '## Checkpoint\n\nContinue here.');
  assert.equal(detail[1].summary, 'Legacy checkpoint');
  assert.equal(detail[2].text, 'actual request');
});

test('does not render inactive Hermes compaction archive copies', () => {
  const rows = [
    { role: 'user', content: 'preserved request', timestamp: 1, active: 0, compacted: 1 },
    { role: 'user', content: 'preserved request', timestamp: 1, active: 1, compacted: 0 },
    { role: 'assistant', content: 'preserved response', timestamp: 2, active: 0, compacted: 1 },
    { role: 'assistant', content: 'preserved response', timestamp: 2, active: 1, compacted: 0 },
  ];

  const detail = detailHermesRows(rows);
  assert.deepEqual(detail.map(message => message.text), ['preserved request', 'preserved response']);
});

test('parses DeepSeek Harness summaries and message details', () => {
  const rows = [
    { type: 'session', id: 'session-1', createdAt: 1785515761653, cwd: '/tmp/dsh-project' },
    { type: 'request/header', time: 1785515762000,
      data: { header: { config: { model: 'deepseek-v4-pro', reasoningEffort: 'max' } } } },
    { type: 'user/message', time: 1785515763000,
      data: { content: [{ type: 'text', text: 'build it' }] } },
    { type: 'session/title', time: 1785515763100, data: { title: 'Build the project' } },
    { type: 'assistant/message', time: 1785515764000, data: {
      message: { source: { model: 'deepseek-v4-pro' }, content: [
        { type: 'reasoning', text: 'inspect first' }, { type: 'text', text: 'working' },
      ] },
      usage: { inputTokens: 100, cacheReadTokens: 200, outputTokens: 50, reasoningTokens: 20 },
    } },
    { type: 'tool/call', time: 1785515765000,
      data: { callId: 'call-1', name: 'bash', arguments: '{"command":"npm test"}' } },
    { type: 'tool/result', time: 1785515766000, data: { message: {
      source: { kind: 'tool', callId: 'call-1' }, content: [{
      type: 'tool-result', content: [{ type: 'text', text: 'tests passed' }],
    }] } } },
    { type: 'tool/result', time: 1785515767000, data: { message: {
      source: { kind: 'tool', callId: 'call-1' }, content: [{
      type: 'tool-result', content: [{ type: 'text', text: 'tests passed' }],
    }] } } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const file = '/tmp/project/session-1/session.jsonl.zstd';
  const summary = summarizeDsh(file, { size: content.length }, content);

  assert.equal(summary.source, 'dsh');
  assert.equal(summary.id, 'session-1');
  assert.equal(summary.project, '/tmp/dsh-project');
  assert.equal(summary.title, 'Build the project');
  assert.equal(summary.model, 'deepseek-v4-pro');
  assert.equal(summary.thinkingEffort, 'max');
  assert.equal(summary.turns, 2);
  assert.equal(summary.contextTokens, 300);
  assert.equal(summary.usage.cachedInputTokens, 200);

  const detail = detailDsh(file, content);
  assert.deepEqual(detail.map(m => m.role), ['user', 'thinking', 'assistant', 'tool_use', 'tool_result']);
  assert.deepEqual(detail[3].bash, { command: 'npm test' });
  assert.equal(detail[4].callId, 'call-1');
  assert.equal(detail[4].toolName, 'bash');
  assert.equal(detail[4].output, 'tests passed');
  assert.equal(detail.filter(message => message.role === 'tool_result').length, 1);
});

test('renders DeepSeek Harness compaction summaries and context peaks', () => {
  const rows = [
    { type: 'session', id: 'session-compact', createdAt: 1785515761000, cwd: '/tmp/project' },
    { type: 'user/message', time: 1785515762000, data: { content: [{ type: 'text', text: 'work' }] } },
    { type: 'assistant/message', time: 1785515763000, data: {
      message: { source: { model: 'deepseek-v4-flash' }, content: [{ type: 'text', text: 'before' }] },
      usage: { inputTokens: 1000, cacheReadTokens: 999000, outputTokens: 10 },
    } },
    { type: 'compact/start', time: 1785515764000, data: { turn: 1 } },
    { type: 'compact/summary', time: 1785515765500, data: {
      summary: [{ type: 'text', text: '## Checkpoint\n\nContinue from here.' }],
      shadowedTokenCount: 900000, shadowedRange: { start: 1, end: 20 }, model: 'deepseek-v4-flash',
    } },
    { type: 'user/message', time: 1785515765750, data: { content: [
      { type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span.' },
      { type: 'text', text: '<compacted-summary>\n## Checkpoint\n\nContinue from here.\n</compacted-summary>' },
    ] } },
    { type: 'compact/end', time: 1785515766000, data: { turn: 1 } },
    { type: 'assistant/message', time: 1785515767000, data: {
      message: { source: { model: 'deepseek-v4-flash' }, content: [{ type: 'text', text: 'after' }] },
      usage: { inputTokens: 1000, cacheReadTokens: 380000, outputTokens: 10 },
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeDsh('/tmp/session.jsonl.zstd', { size: content.length }, content);
  const detail = detailDsh('/tmp/session.jsonl.zstd', content);

  assert.deepEqual(summary.contextPeaks, [1000000]);
  assert.equal(summary.contextTokens, 381000);
  assert.equal(summary.turns, 3);
  assert.deepEqual(detail.map(message => message.role), ['user', 'assistant', 'compaction', 'assistant']);
  assert.equal(detail[2].beforeTokens, 1000000);
  assert.equal(detail[2].durationMs, 2000);
  assert.equal(detail[2].summary, '## Checkpoint\n\nContinue from here.');
  assert.equal(detail[2].shadowedTokens, 900000);
});

test('renders DeepSeek Harness background task completions as task events', () => {
  const rows = [
    { type: 'user/message', time: 1785515762000, data: {
      content: [{ type: 'text', text:
        'background task bash-7 (bash: npm test) finished [status: completed, exit code: 0]. Read its output with task_output.' }],
      source: { kind: 'plugin', plugin: 'tool-tasks' }, role: 'user',
    } },
    { type: 'user/message', time: 1785515763000, data: {
      content: [{ type: 'text', text:
        'background task bash-8 (bash: ordinary user text) finished [status: completed, exit code: 0].' }],
      role: 'user',
    } },
  ];

  const detail = detailDsh('/tmp/session.jsonl.zstd', rows.map(JSON.stringify).join('\n'));

  assert.equal(detail[0].role, 'background_task');
  assert.equal(detail[0].event, 'completed');
  assert.equal(detail[0].taskId, 'bash-7');
  assert.equal(detail[0].toolName, 'bash');
  assert.equal(detail[0].command, 'npm test');
  assert.equal(detail[0].exitCode, 0);
  assert.equal(detail[1].role, 'user');
});

test('renders DeepSeek Harness goal updates as events and excludes them from user turns', () => {
  const goal = {
    id: 'goal-example', revision: 2, objective: 'Ship the example', phase: 'blocked', maxGoalRounds: 8,
    blockedReason: { code: 'example-error', message: 'Example dependency unavailable' },
  };
  const rows = [
    { type: 'session', id: 'session-goal', createdAt: 1785515761000, cwd: '/tmp/project' },
    { type: 'user/message', time: 1785515762000, data: {
      content: [{ type: 'text', text: '<goal_state>{"example":true}</goal_state>' }],
      source: { kind: 'goal', goalId: goal.id, revision: 2, round: 0,
        change: { kind: 'goal/change', operation: 'block', goal } },
    } },
    { type: 'user/message', time: 1785515763000, data: {
      content: [{ type: 'text', text: '<goal_round>\nObjective: "Ship the example"\nRound: 3/8\n</goal_round>' }],
      source: { kind: 'goal', goalId: goal.id, revision: 2, round: 3 },
    } },
    { type: 'user/message', time: 1785515763500, data: {
      content: [{ type: 'text', text: 'Runtime policy snapshot with revised wording.' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
    } },
    { type: 'user/message', time: 1785515764000,
      data: { content: [{ type: 'text', text: 'continue the work' }] } },
    { type: 'assistant/message', time: 1785515765000, data: {
      message: { source: { model: 'deepseek-v4-flash' }, content: [{ type: 'text', text: 'working' }] },
      usage: { inputTokens: 10, outputTokens: 2 },
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const detail = detailDsh('/tmp/session.jsonl.zstd', content);
  const summary = summarizeDsh('/tmp/session.jsonl.zstd', { size: content.length }, content);

  assert.deepEqual(detail.map(message => message.role), ['goal', 'goal', 'runtime_context', 'user', 'assistant']);
  assert.equal(detail[0].event, 'block');
  assert.equal(detail[0].objective, 'Ship the example');
  assert.equal(detail[0].reason, 'Example dependency unavailable');
  assert.equal(detail[1].event, 'round');
  assert.equal(detail[1].round, 3);
  assert.equal(detail[1].maxRounds, 8);
  assert.equal(detail[2].text, 'Runtime policy snapshot with revised wording.');
  assert.equal(summary.turns, 2);
  assert.equal(summary.title, 'continue the work');
});

test('extracts Codex thinking effort from turn context', () => {
  const rows = [
    { type: 'session_meta', timestamp: '2026-07-17T00:00:00Z',
      payload: { id: 'codex-1', cwd: '/tmp/project' } },
    { type: 'turn_context', timestamp: '2026-07-17T00:00:01Z',
      payload: { model: 'gpt-5.4', effort: 'high' } },
    { type: 'event_msg', timestamp: '2026-07-17T00:00:02Z',
      payload: { type: 'user_message', message: 'hello' } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeCodex('/tmp/session.jsonl', { size: content.length }, content);
  assert.equal(summary.thinkingEffort, 'high');
});

test('recognizes Codex auto-review as a guardian subagent', () => {
  const rows = [
    { type: 'session_meta', timestamp: '2026-08-01T00:00:00Z', payload: {
      session_id: 'parent-1', id: 'review-1', parent_thread_id: 'parent-1',
      cwd: '/tmp/project', thread_source: 'subagent', source: { subagent: { other: 'guardian' } },
    } },
    { type: 'turn_context', payload: { model: 'codex-auto-review', effort: 'low' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Review this action' } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const review = summarizeCodex('/tmp/review.jsonl', { size: content.length }, content);
  const parent = { source: 'codex', id: 'parent-1', file: '/tmp/parent.jsonl' };

  linkCodexSubagents([parent, review]);

  assert.equal(review.id, 'review-1');
  assert.equal(review.title, 'Codex auto-review');
  assert.equal(review.sessionKind, 'subagent');
  assert.equal(review.subagentType, 'guardian');
  assert.equal(review.parentSessionId, 'parent-1');
  assert.equal(review.parentFile, '/tmp/parent.jsonl');
});

test('normalizes provider and dated model aliases', () => {
  assert.equal(normalizeModelName('openai/gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(normalizeModelName('azure-gpt-5.4-2026-03-05'), 'gpt-5.4');
  assert.equal(priceForModel('anthropic/claude-opus-4-8').input, 5);
});

test('normalizes thinking effort from runtime-specific configurations', () => {
  assert.equal(extractThinkingEffort({ thinkingLevel: 'low' }), 'low');
  assert.equal(extractThinkingEffort('{"reasoning_config":{"effort":"high"}}'), 'high');
  assert.equal(extractThinkingEffort({ reasoningEffort: 'max' }), 'max');
  assert.equal(extractThinkingEffort({ reasoning_config: null }), null);
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

test('uses the current GPT-5.6 Luna prices, including cache writes', () => {
  const shortUsage = normalizedUsage({ input_tokens: 100_000, cached_input_tokens: 10_000, output_tokens: 100_000 }, 'codex');
  const short = summarizeUsageRecords([{ model: 'gpt-5.6-luna', usage: shortUsage }]);
  assert.equal(short.cost.usd, .1382);

  const longUsage = normalizedUsage({ input_tokens: 300_000, output_tokens: 1_000_000, cache_write_tokens: 100_000 }, 'codex');
  const long = summarizeUsageRecords([{ model: 'gpt-5.6-luna', usage: longUsage }]);
  assert.equal(long.cost.usd, 1.97);
});

test('deduplicates repeated Claude log entries by message id', () => {
  const user = { type: 'user', message: { content: 'hello' }, timestamp: '2026-07-17T00:00:00Z' };
  const assistant = {
    type: 'assistant',
    effort: 'xhigh',
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
  assert.equal(summary.thinkingEffort, 'xhigh');
  assert.equal(summary.usage.requests, 1);
  assert.equal(summary.usage.totalTokens, 310);
  assert.equal(summary.cost.usd, 0.0017);
});

test('uses the latest Claude Code custom title after rename', () => {
  const rows = [
    { type: 'user', message: { content: 'original prompt' } },
    { type: 'summary', summary: 'Generated summary' },
    { type: 'custom-title', customTitle: 'First rename' },
    { type: 'custom-title', customTitle: '  Latest renamed session  ' },
  ];
  const summary = summarizeClaude('/tmp/session.jsonl', { size: 1 },
    rows.map(JSON.stringify).join('\n'));

  assert.equal(summary.title, 'Latest renamed session');
});

test('splits usage records into per-day per-model cost buckets', () => {
  const { summarizeDailyRecords } = require('../server');
  const usage = normalizedUsage({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude');
  const records = [
    { model: 'claude-fable-5', usage, ts: '2026-07-20T18:00:00+08:00' },
    { model: 'claude-fable-5', usage, ts: '2026-07-20T19:00:00+08:00' },
    { model: 'gpt-5.5', usage, ts: '2026-07-21T08:00:00+08:00' },
    { model: 'gpt-5.5', usage, ts: null }, // 无时间戳的记录不进入按天统计
  ];
  const daily = summarizeDailyRecords(records);

  assert.equal(daily.length, 2);
  assert.deepEqual(daily.map(d => d.model), ['claude-fable-5', 'gpt-5.5']);
  assert.equal(daily[0].usd, 20); // 2M input @ $10/M
  assert.equal(daily[0].requests, 2);
  assert.equal(daily[0].tokenUsage, 2_000_000);
  assert.ok(daily[0].date <= daily[1].date);
});

test('daily token usage includes input and output but excludes cache tokens', () => {
  const { summarizeDailyRecords } = require('../server');
  const usage = normalizedUsage({
    input_tokens: 1_100,
    cached_input_tokens: 900,
    output_tokens: 50,
  }, 'codex');
  const [daily] = summarizeDailyRecords([
    { model: 'gpt-5.5', usage, ts: '2026-07-21T08:00:00+08:00' },
  ]);

  assert.equal(daily.tokenUsage, 250);
  assert.equal(daily.totalTokens, 1_150);
});

test('claude summaries expose daily cost and activity buckets', () => {
  const mkAssistant = (id, ts) => ({
    type: 'assistant', timestamp: ts,
    message: {
      id, model: 'claude-fable-5', content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 100, output_tokens: 10 },
    },
  });
  const rows = [
    { type: 'user', message: { content: 'hello' }, timestamp: '2026-07-19T23:00:00Z' },
    mkAssistant('m1', '2026-07-19T23:00:10Z'),
    mkAssistant('m2', '2026-07-20T01:00:00Z'),
  ];
  const summary = summarizeClaude('/tmp/session.jsonl', { size: 1 },
    rows.map(JSON.stringify).join('\n'));

  assert.equal(summary.daily.reduce((a, d) => a + d.requests, 0), 2);
  assert.ok(summary.daily.every(d => d.model === 'claude-fable-5'));
  assert.equal(summary.activity.reduce((a, d) => a + d.turns, 0), 3);
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
    parentSessionKey: 'agent:main:main', parentSessionId: 'parent-1', status: 'done', thinkingLevel: 'low',
  });

  assert.equal(summary.project, '/tmp/project');
  assert.equal(summary.title, 'worker');
  assert.equal(summary.sessionKind, 'subagent');
  assert.equal(summary.thinkingEffort, 'low');
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

test('parses Cetus sessions with the compatible event format', () => {
  const file = path.join(os.homedir(), 'Library', 'Application Support', 'dev.cetus.app', 'sessions', 'session.jsonl');
  const rows = [
    { type: 'session', id: 'cetus-1', timestamp: '2026-08-01T00:00:00Z', cwd: '/tmp/cetus-project' },
    { type: 'model_change', timestamp: '2026-08-01T00:00:01Z', provider: 'openai', modelId: 'gpt-5.4' },
    { type: 'message', timestamp: '2026-08-01T00:00:02Z', message: { role: 'user', content: 'ship it' } },
    { type: 'message', timestamp: '2026-08-01T00:00:03Z', message: {
      role: 'assistant', model: 'gpt-5.4', content: [{ type: 'text', text: 'done' }],
      usage: { input: 10, output: 2, cacheRead: 3, totalTokens: 15 },
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeCetus(file, { size: content.length }, content);

  assert.equal(summary.source, 'cetus');
  assert.equal(summary.id, 'cetus-1');
  assert.equal(summary.project, '/tmp/cetus-project');
  assert.equal(summary.version, 'Cetus');
  assert.equal(summary.usage.totalTokens, 15);
  assert.deepEqual(detailCetus(file, content).map(message => message.role), ['user', 'assistant']);
});

test('preserves Cetus multi-edit arguments for diff rendering', () => {
  const row = {
    type: 'message', timestamp: '2026-08-01T00:00:00Z', message: { role: 'assistant', content: [{
      type: 'toolCall', id: 'edit-1', name: 'edit', arguments: {
        path: '/tmp/example.js', edits: [
          { oldText: 'const first = 1;', newText: 'const first = 2;' },
          { oldText: 'const second = 1;', newText: 'const second = 2;' },
        ],
      },
    }] },
  };
  const [message] = detailCetus('/tmp/cetus.jsonl', JSON.stringify(row));

  assert.deepEqual(message.edit, {
    path: '/tmp/example.js',
    edits: [
      { oldText: 'const first = 1;', newText: 'const first = 2;' },
      { oldText: 'const second = 1;', newText: 'const second = 2;' },
    ],
    replaceAll: false,
  });
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

test('renders Claude Code subagent launch and completion as agent events', () => {
  const rows = [
    { type: 'user', timestamp: '2026-07-18T00:00:00Z', toolUseResult: {
      isAsync: true, status: 'async_launched', agentId: 'worker-2', description: 'Find benchmarks',
    }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'launched' }] } },
    { type: 'user', timestamp: '2026-07-18T00:01:00Z', message: { role: 'user', content:
      '<task-notification>\n<task-id>worker-2</task-id>\n<status>completed</status>\n' +
      '<summary>Agent "Find benchmarks" finished</summary>\n<result>done</result>\n</task-notification>' } },
  ];
  const detail = detailClaude('/tmp/project/main.jsonl', rows.map(JSON.stringify).join('\n'));

  assert.deepEqual(detail.map(m => [m.role, m.event, m.agentId]), [
    ['subagent', 'started', 'worker-2'],
    ['subagent', 'completed', 'worker-2'],
  ]);
  assert.equal(detail[1].title, 'Find benchmarks');
});

test('renders synchronous Claude Code Agent calls with their subagent type', () => {
  const rows = [
    { type: 'assistant', timestamp: '2026-07-19T00:00:00Z', message: { content: [{
      type: 'tool_use', id: 'call-agent-1', name: 'Agent', input: {
        description: 'Map the example modules', subagent_type: 'Explore',
      },
    }] } },
    { type: 'user', timestamp: '2026-07-19T00:01:00Z', toolUseResult: {
      agentId: 'example-agent-id', agentType: 'Explore',
    }, message: { content: [{
      type: 'tool_result', tool_use_id: 'call-agent-1', content: 'Example findings',
    }] } },
  ];
  const detail = detailClaude('/tmp/example-project/main.jsonl', rows.map(JSON.stringify).join('\n'));

  assert.deepEqual(detail.map(m => [m.role, m.event, m.agentId, m.subagentType]), [
    ['subagent', 'started', 'example-agent-id', 'Explore'],
    ['subagent', 'completed', 'example-agent-id', 'Explore'],
  ]);
  assert.equal(detail[0].title, 'Map the example modules');
});

test('remote scans retain subagents belonging to selected parent sessions', () => {
  const lines = [];
  for (let i = 0; i < 11; i++) {
    lines.push(`FILE\tclaude\t${100 - i}\t10\t/remote/project/session-${i}.jsonl`);
  }
  lines.push('FILE\tclaude\t95\t5\t/remote/project/session-2/subagents/agent-example.jsonl');

  const scan = require('../server').parseRemoteScan(lines.join('\n'));

  assert.equal(scan.files.filter(file => !file.path.includes('/subagents/')).length, 10);
  assert.ok(scan.files.some(file => file.path.endsWith('/session-2/subagents/agent-example.jsonl')));
});

test('preserves structured Edit arguments for diff rendering', () => {
  const edit = {
    type: 'assistant', timestamp: '2026-07-18T00:00:00Z', message: { content: [{
      type: 'tool_use', id: 'edit-1', name: 'Edit', input: {
        file_path: '/tmp/example.js', old_string: 'const old = true;\n',
        new_string: 'const updated = true;\n', replace_all: true,
      },
    }] },
  };
  const [message] = detailClaude('/tmp/project/main.jsonl', JSON.stringify(edit));

  assert.deepEqual(message.edit, {
    path: '/tmp/example.js', oldText: 'const old = true;\n',
    newText: 'const updated = true;\n', replaceAll: true,
  });
  assert.ok(message.input.includes('old_string'));
});

test('preserves Bash commands and Write content for specialized rendering', () => {
  const row = {
    type: 'assistant', timestamp: '2026-07-18T00:00:00Z', message: { content: [
      { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'npm test\necho done' } },
      { type: 'tool_use', id: 'write-1', name: 'Write', input: {
        file_path: '/tmp/new.txt', content: 'first line\nsecond line\n',
      } },
    ] },
  };
  const detail = detailClaude('/tmp/project/main.jsonl', JSON.stringify(row));

  assert.deepEqual(detail[0].bash, { command: 'npm test\necho done' });
  assert.deepEqual(detail[1].write, {
    path: '/tmp/new.txt', content: 'first line\nsecond line\n',
  });
});

test('preserves complete Read results and structured file ranges', () => {
  const fileContent = Array.from({ length: 80 }, (_, i) => `line ${i + 1}: ${'x'.repeat(12)}`).join('\n');
  const rows = [
    { type: 'assistant', timestamp: '2026-07-18T00:00:00Z', message: { content: [{
      type: 'tool_use', id: 'read-1', name: 'Read', input: {
        file_path: '/tmp/long.txt', offset: 20, limit: 80,
      },
    }] } },
    { type: 'user', timestamp: '2026-07-18T00:00:01Z', message: { content: [{
      type: 'tool_result', tool_use_id: 'read-1', content: fileContent,
    }] } },
  ];
  const detail = detailClaude('/tmp/project/main.jsonl', rows.map(JSON.stringify).join('\n'));

  assert.deepEqual(detail[0].read, {
    path: '/tmp/long.txt', offset: 20, limit: 80, pages: null,
  });
  assert.ok(fileContent.length > 600);
  assert.equal(detail[1].output, fileContent);
  assert.equal(detail[1].readContent, fileContent);
});

test('renders context compaction events from supported logs', () => {
  const claude = detailClaude('/tmp/project/main.jsonl', JSON.stringify({
    type: 'system', subtype: 'compact_boundary', timestamp: '2026-07-18T00:00:00Z',
    compactMetadata: { trigger: 'auto', preTokens: 167000, postTokens: 4200, durationMs: 1500 },
  }));
  assert.deepEqual(claude, [{
    role: 'compaction', ts: '2026-07-18T00:00:00Z', trigger: 'auto',
    beforeTokens: 167000, afterTokens: 4200, durationMs: 1500,
  }]);

  const codex = detailCodex('/tmp/session.jsonl', JSON.stringify({
    type: 'compacted', timestamp: '2026-07-18T00:01:00Z',
    payload: { trigger: 'manual', tokens_before: 120000, tokens_after: 5000,
      message: '## Checkpoint\n\nContinue from here.' },
  }));
  assert.equal(codex[0].role, 'compaction');
  assert.equal(codex[0].beforeTokens, 120000);
  assert.equal(codex[0].summary, '## Checkpoint\n\nContinue from here.');

  const openClaw = detailOpenClaw('/tmp/session.jsonl', JSON.stringify({
    type: 'compaction', timestamp: '2026-07-18T00:02:00Z', fromHook: true, tokensBefore: 190000,
  }));
  assert.equal(openClaw[0].role, 'compaction');
  assert.equal(openClaw[0].trigger, 'auto');
  assert.equal(openClaw[0].beforeTokens, 190000);
});

test('merges Codex compaction completion notifications into their compacted summaries', () => {
  const rows = [
    { type: 'session_meta', timestamp: '2026-07-18T00:00:00Z', payload: {
      id: 'session-context', cwd: '/tmp/example-project', originator: 'Codex CLI',
    } },
    { type: 'turn_context', timestamp: '2026-07-18T00:00:01Z', payload: { model: 'gpt-5.5' } },
    { type: 'event_msg', timestamp: '2026-07-18T00:00:02Z', payload: {
      type: 'user_message', message: 'Build a fictional example.',
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:01:00Z', payload: {
      type: 'token_count', info: { last_token_usage: { total_tokens: 120000 } },
    } },
    { type: 'compacted', timestamp: '2026-07-18T00:01:01Z', payload: {
      message: 'First synthetic checkpoint.',
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:01:02Z', payload: {
      type: 'token_count', info: { last_token_usage: { total_tokens: 7000 } },
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:01:03Z', payload: {
      type: 'context_compacted',
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:02:00Z', payload: {
      type: 'token_count', info: { last_token_usage: { total_tokens: 83000 } },
    } },
    { type: 'compacted', timestamp: '2026-07-18T00:02:01Z', payload: {
      message: 'Second synthetic checkpoint.',
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:03:00Z', payload: {
      type: 'token_count', info: { last_token_usage: { total_tokens: 14000 } },
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:03:00Z', payload: {
      type: 'context_compacted',
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:03:01Z', payload: {
      type: 'agent_message', message: 'Finished.',
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeCodex('/tmp/session.jsonl', { size: content.length }, content);
  const detail = detailCodex('/tmp/session.jsonl', content).filter(message => message.role === 'compaction');

  assert.deepEqual(summary.contextPeaks, [120000, 83000]);
  assert.equal(summary.contextTokens, 14000);
  assert.deepEqual(detail.map(message => message.beforeTokens), [120000, 83000]);
  assert.deepEqual(detail.map(message => message.afterTokens), [7000, 14000]);
  assert.deepEqual(detail.map(message => message.summary), [
    'First synthetic checkpoint.', 'Second synthetic checkpoint.',
  ]);
});

test('extracts text blocks from Codex custom tool call outputs', () => {
  const rows = [
    {
      type: 'response_item', timestamp: '2026-07-18T00:00:00Z',
      payload: { type: 'custom_tool_call', name: 'example_tool', call_id: 'call-example', input: '{}' },
    },
    {
      type: 'response_item', timestamp: '2026-07-18T00:00:01Z',
      payload: {
        type: 'custom_tool_call_output', call_id: 'call-example',
        output: [
          { type: 'input_text', text: 'First output line' },
          { type: 'output_text', text: 'Second output line' },
        ],
      },
    },
  ];
  const detail = detailCodex('/tmp/example-session.jsonl', rows.map(JSON.stringify).join('\n'));

  assert.equal(detail[1].role, 'tool_result');
  assert.equal(detail[1].output, 'First output line\nSecond output line');
});
