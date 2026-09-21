// In-chat control tags for the Gemini "thinking" settings — lets you flip
// them per character/chat straight from Janitor's own "Custom Prompt" (or
// jailbreak/persona) field, instead of editing Railway variables and
// redeploying every time.
//
// Janitor resends the whole custom prompt as part of every request, so a
// tag left in there behaves like a standing setting for that chat: it
// applies on every message until you edit the prompt and delete the tag,
// at which point the proxy just falls back to whatever's configured in
// Railway again.
//
// Recognized tags — case-insensitive, `=` or `:` both work as the
// separator, matched wherever they appear across the whole message list
// (system prompt, jailbreak, persona, mid-conversation, doesn't matter):
//
//   <ENABLE_THINKING=true|false>
//   <REASONING_EFFORT=minimal|low|medium|high>
//   <SHOW_REASONING=true|false>
//   <THINKING_BUDGET=1234>     (advanced: raw token budget, any model)
//
// Every matched tag (plus the whitespace/newline immediately around it) is
// removed from the message text before anything else touches it — none of
// this is meant to be visible to the model.

const BOOL_VALUES = { true: true, on: true, 1: true, false: false, off: false, 0: false };
const EFFORT_VALUES = new Set(['minimal', 'low', 'medium', 'high']);

// Each pattern eats its own trailing same-line whitespace plus one trailing
// newline (so a tag on its own line leaves no blank line behind) but
// deliberately does NOT eat anything before the "<" — only the tag's own
// trailing side is swallowed, so a tag sitting mid-sentence ("the door
// <TAG> opens") collapses to a single space ("the door opens") instead of
// gluing the surrounding words together.
const TAG_DEFS = [
  {
    key: 'enableThinking',
    pattern: /<\s*ENABLE_THINKING\s*[:=]\s*(true|false|on|off|1|0)\s*>[ \t]*\n?/gi,
    parse: (raw) => BOOL_VALUES[raw.toLowerCase()],
  },
  {
    key: 'reasoningEffort',
    pattern: /<\s*REASONING_EFFORT\s*[:=]\s*(minimal|low|medium|high)\s*>[ \t]*\n?/gi,
    parse: (raw) => raw.toLowerCase(),
  },
  {
    key: 'showReasoning',
    pattern: /<\s*SHOW_REASONING\s*[:=]\s*(true|false|on|off|1|0)\s*>[ \t]*\n?/gi,
    parse: (raw) => BOOL_VALUES[raw.toLowerCase()],
  },
  {
    key: 'thinkingBudget',
    pattern: /<\s*THINKING_BUDGET\s*[:=]\s*(-?\d+)\s*>[ \t]*\n?/gi,
    parse: (raw) => Number(raw),
  },
];

// Runs every tag pattern over one string, recording the LAST value seen for
// each key (so if a tag somehow appears twice, e.g. in both the custom
// prompt and the jailbreak field, whichever comes later in the message
// list wins) and stripping every match out of the text.
function stripFromText(text, commands) {
  let result = text;
  for (const { key, pattern, parse } of TAG_DEFS) {
    result = result.replace(pattern, (_match, raw) => {
      commands[key] = parse(raw);
      return '';
    });
  }
  return result;
}

// Scans every message's content for the tags above, strips them out, and
// returns both the parsed commands and a cleaned copy of the message list.
// Handles both plain string content and OpenAI-style array content
// ([{ type: 'text', text: '...' }, ...]) — Janitor sends the former, but
// this stays correct either way. Messages with nothing to strip are
// returned unchanged (same object) so callers can cheaply tell nothing
// happened.
export function extractInlineCommands(messages = []) {
  const commands = {};

  const cleaned = messages.map((msg) => {
    if (!msg) return msg;

    if (typeof msg.content === 'string') {
      const text = stripFromText(msg.content, commands);
      return text === msg.content ? msg : { ...msg, content: text };
    }

    if (Array.isArray(msg.content)) {
      let changed = false;
      const parts = msg.content.map((part) => {
        if (part && typeof part.text === 'string') {
          const text = stripFromText(part.text, commands);
          if (text !== part.text) {
            changed = true;
            return { ...part, text };
          }
        }
        return part;
      });
      return changed ? { ...msg, content: parts } : msg;
    }

    return msg;
  });

  return { commands, messages: cleaned };
}

// Folds parsed inline commands into a per-request cfg/body pair:
//
// - ENABLE_THINKING has no body-level equivalent (it's purely the
//   ENABLE_THINKING master switch from config.js), so it's applied to a
//   shallow-cloned `cfg`.
// - REASONING_EFFORT / SHOW_REASONING / THINKING_BUDGET are applied to a
//   shallow-cloned `body`, reusing the exact per-request override fields
//   resolveThinkingConfig() (lib/generationDefaults.js) already
//   understands and already treats as taking precedence over cfg —
//   regardless of ENABLE_THINKING. That's what lets e.g. a bare
//   <REASONING_EFFORT=high> tag force thinking on for one chat even when
//   Railway's own ENABLE_THINKING is left off.
//
// Pass the returned { cfg, body } into resolveThinkingConfig in place of
// the originals; everything else about the request is untouched.
export function applyInlineCommands(cfg, body, commands) {
  const effectiveCfg =
    commands.enableThinking === undefined ? cfg : { ...cfg, enableThinking: commands.enableThinking };

  const effectiveBody = { ...body };
  if (commands.reasoningEffort !== undefined) {
    effectiveBody.thinking_level = commands.reasoningEffort;
  }
  if (commands.thinkingBudget !== undefined) {
    effectiveBody.thinking_budget = commands.thinkingBudget;
  }
  if (commands.showReasoning !== undefined) {
    effectiveBody.include_thoughts = commands.showReasoning;
  }

  return { cfg: effectiveCfg, body: effectiveBody };
    }
