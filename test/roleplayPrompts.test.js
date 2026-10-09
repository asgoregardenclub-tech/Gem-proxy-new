import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildRoleplayDirectives, mergeSystemInstruction, normalizeChoice, RESPONSE_LENGTHS } = await import(
  '../src/lib/roleplayPrompts.js'
);
const { extractInlineCommands, applyInlineCommands } = await import('../src/lib/inlineCommands.js');

test('nothing configured: no directives', () => {
  assert.equal(buildRoleplayDirectives({}), undefined);
  assert.equal(buildRoleplayDirectives({ noAism: false, livingWorld: false }), undefined);
});

test('each response length produces its own text', () => {
  const seen = new Set();
  for (const len of RESPONSE_LENGTHS) {
    const text = buildRoleplayDirectives({ responseLength: len });
    assert.ok(text.includes(`RESPONSE LENGTH`), len);
    seen.add(text);
  }
  assert.equal(seen.size, RESPONSE_LENGTHS.length);
});

test('invalid enum values are ignored', () => {
  assert.equal(buildRoleplayDirectives({ responseLength: 'huge', narrationMode: 'epic' }), undefined);
  assert.equal(normalizeChoice('LONG', RESPONSE_LENGTHS), 'long');
});

test('banter drops narration style and living world (they contradict it)', () => {
  const text = buildRoleplayDirectives({ responseLength: 'banter', narrationMode: 'professional', livingWorld: true });
  assert.ok(!text.includes('NARRATION STYLE'));
  assert.ok(!text.includes('LIVING WORLD'));
});

test('toggles stack', () => {
  const text = buildRoleplayDirectives({
    noAism: true,
    forceMarkdown: true,
    realTexting: true,
    livingWorld: true,
    narrationMode: 'simple',
  });
  for (const s of ['NO AI CLICHES', 'FORMATTING', 'REALISTIC TEXTING', 'LIVING WORLD', 'NARRATION STYLE — SIMPLE']) {
    assert.ok(text.includes(s), s);
  }
});

test('mergeSystemInstruction appends to or creates a systemInstruction', () => {
  assert.equal(mergeSystemInstruction(undefined, undefined), undefined);
  assert.deepEqual(mergeSystemInstruction(undefined, 'x'), { parts: [{ text: 'x' }] });
  assert.deepEqual(mergeSystemInstruction({ parts: [{ text: 'a' }] }, 'b'), { parts: [{ text: 'a' }, { text: 'b' }] });
  const base = { parts: [{ text: 'a' }] };
  assert.equal(mergeSystemInstruction(base, undefined), base);
});

test('inline tags are parsed, stripped, and applied to cfg', () => {
  const messages = [
    {
      role: 'system',
      content:
        'Persona here.\n<RESPONSE_LENGTH=Long>\n<NO_AISM=on>\n<narration_mode:professional>\n<FORCE_MARKDOWN=true>\n<LIVING_WORLD=1>\n<REAL_TEXTING=true>\nEnd.',
    },
  ];
  const { commands, messages: cleaned } = extractInlineCommands(messages);

  assert.equal(cleaned[0].content, 'Persona here.\nEnd.');
  assert.deepEqual(commands, {
    responseLength: 'long',
    noAism: true,
    narrationMode: 'professional',
    forceMarkdown: true,
    livingWorld: true,
    realTexting: true,
  });

  const { cfg } = applyInlineCommands({ noAism: false, responseLength: 'short' }, {}, commands);
  assert.equal(cfg.responseLength, 'long');
  assert.equal(cfg.noAism, true);
});

test('inline NO_AISM=false overrides a Railway-level true', () => {
  const { commands } = extractInlineCommands([{ role: 'system', content: '<NO_AISM=false>' }]);
  const { cfg } = applyInlineCommands({ noAism: true }, {}, commands);
  assert.equal(buildRoleplayDirectives(cfg), undefined);
});

test('invalid inline values are left in the text', () => {
  const { commands, messages } = extractInlineCommands([{ role: 'system', content: '<RESPONSE_LENGTH=huge>' }]);
  assert.equal(commands.responseLength, undefined);
  assert.equal(messages[0].content, '<RESPONSE_LENGTH=huge>');
});

test('no commands: cfg returned untouched (same object)', () => {
  const cfg = { noAism: true };
  assert.equal(applyInlineCommands(cfg, {}, {}).cfg, cfg);
});
