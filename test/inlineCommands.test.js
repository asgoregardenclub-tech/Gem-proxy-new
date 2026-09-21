import { test } from 'node:test';
import assert from 'node:assert/strict';

const { extractInlineCommands, applyInlineCommands } = await import('../src/lib/inlineCommands.js');
const { resolveThinkingConfig } = await import('../src/lib/generationDefaults.js');

test('extracts ENABLE_THINKING and strips the tag + its own line', () => {
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.\n<ENABLE_THINKING=true>\nStay in character.' },
  ];
  const { commands, messages: cleaned } = extractInlineCommands(messages);

  assert.equal(commands.enableThinking, true);
  assert.equal(cleaned[0].content, 'You are a helpful assistant.\nStay in character.');
});

test('REASONING_EFFORT is case-insensitive and accepts a colon separator', () => {
  const messages = [{ role: 'system', content: '<reasoning_effort:HIGH>' }];
  const { commands, messages: cleaned } = extractInlineCommands(messages);

  assert.equal(commands.reasoningEffort, 'high');
  assert.equal(cleaned[0].content, '');
});

test('SHOW_REASONING accepts on/off as well as true/false', () => {
  const messages = [{ role: 'system', content: '<SHOW_REASONING=off>' }];
  const { commands } = extractInlineCommands(messages);
  assert.equal(commands.showReasoning, false);
});

test('THINKING_BUDGET parses to a number', () => {
  const messages = [{ role: 'system', content: '<THINKING_BUDGET=4096>' }];
  const { commands } = extractInlineCommands(messages);
  assert.equal(commands.thinkingBudget, 4096);
});

test('tags can be spread across multiple messages, including array-style content', () => {
  const messages = [
    { role: 'system', content: '<ENABLE_THINKING=true>' },
    { role: 'user', content: [{ type: 'text', text: 'Hi <REASONING_EFFORT=medium> there' }] },
  ];
  const { commands, messages: cleaned } = extractInlineCommands(messages);

  assert.equal(commands.enableThinking, true);
  assert.equal(commands.reasoningEffort, 'medium');
  assert.equal(cleaned[1].content[0].text, 'Hi there');
});

test('no tags present: commands empty, messages returned unchanged', () => {
  const messages = [{ role: 'system', content: 'Nothing special here.' }];
  const { commands, messages: cleaned } = extractInlineCommands(messages);

  assert.deepEqual(commands, {});
  assert.equal(cleaned[0], messages[0]); // same object, not just equal content
});

test('invalid values are left in place and not recorded as commands', () => {
  const messages = [{ role: 'system', content: '<REASONING_EFFORT=extreme>' }];
  const { commands, messages: cleaned } = extractInlineCommands(messages);

  assert.equal(commands.reasoningEffort, undefined);
  assert.equal(cleaned[0].content, '<REASONING_EFFORT=extreme>');
});

// --- Integration with resolveThinkingConfig ---------------------------

test('a bare REASONING_EFFORT tag forces thinking on even with ENABLE_THINKING off in Railway', () => {
  const cfg = { enableThinking: false, reasoningEffort: undefined, showReasoning: false };
  const body = {};
  const commands = { reasoningEffort: 'high' };

  const { cfg: effectiveCfg, body: effectiveBody } = applyInlineCommands(cfg, body, commands);
  const thinkingConfig = resolveThinkingConfig('gemini-3.7-flash', effectiveBody, effectiveCfg);

  assert.deepEqual(thinkingConfig, { thinkingLevel: 'high' });
});

test('ENABLE_THINKING=false turns off the Railway-configured default for this request', () => {
  const cfg = { enableThinking: true, reasoningEffort: 'medium', showReasoning: false };
  const body = {};
  const commands = { enableThinking: false };

  const { cfg: effectiveCfg, body: effectiveBody } = applyInlineCommands(cfg, body, commands);
  const thinkingConfig = resolveThinkingConfig('gemini-3.7-flash', effectiveBody, effectiveCfg);

  assert.equal(thinkingConfig, undefined);
});

test('ENABLE_THINKING=true rides on the Railway-configured REASONING_EFFORT when no inline effort is given', () => {
  const cfg = { enableThinking: false, reasoningEffort: 'low', showReasoning: false };
  const body = {};
  const commands = { enableThinking: true };

  const { cfg: effectiveCfg, body: effectiveBody } = applyInlineCommands(cfg, body, commands);
  const thinkingConfig = resolveThinkingConfig('gemini-3.7-flash', effectiveBody, effectiveCfg);

  assert.deepEqual(thinkingConfig, { thinkingLevel: 'low' });
});

test('SHOW_REASONING=true adds includeThoughts regardless of thinking level', () => {
  const cfg = { enableThinking: false, reasoningEffort: undefined, showReasoning: false };
  const body = {};
  const commands = { showReasoning: true };

  const { cfg: effectiveCfg, body: effectiveBody } = applyInlineCommands(cfg, body, commands);
  const thinkingConfig = resolveThinkingConfig('gemini-3.7-flash', effectiveBody, effectiveCfg);

  assert.deepEqual(thinkingConfig, { includeThoughts: true });
});

test('no commands: cfg/body pass through untouched', () => {
  const cfg = { enableThinking: true, reasoningEffort: 'low', showReasoning: false };
  const body = { model: 'gemini-3.7-flash' };

  const { cfg: effectiveCfg, body: effectiveBody } = applyInlineCommands(cfg, body, {});

  assert.equal(effectiveCfg, cfg); // same object — no clone when nothing to override
  assert.deepEqual(effectiveBody, body);
});
