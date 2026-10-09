// Toggleable roleplay-quality prompts. Each setting adds a short directive
// block to Gemini's systemInstruction. Everything is OFF/unset by default,
// and every one can be flipped per-chat with an inline tag (see
// lib/inlineCommands.js), e.g. <RESPONSE_LENGTH=long> in Janitor's Custom
// Prompt field.
//
// Settings (all live on cfg, same shape as config.js):
//   responseLength : 'banter' | 'short' | 'medium' | 'long' | 'novel'
//   noAism         : boolean
//   forceMarkdown  : boolean
//   narrationMode  : 'simple' | 'professional'
//   livingWorld    : boolean
//   realTexting    : boolean
//   dialogueRatio  : 'low' | 'medium' | 'high'
//   pacing         : 'slow' | 'normal' | 'fast'
//   varyOpeners    : boolean
//   realism        : boolean
//   continuity     : boolean
//   proactive      : boolean

export const RESPONSE_LENGTHS = ['banter', 'short', 'medium', 'long', 'novel'];
export const NARRATION_MODES = ['simple', 'professional'];
export const DIALOGUE_RATIOS = ['low', 'medium', 'high'];
export const PACINGS = ['slow', 'normal', 'fast'];

// Returns the lowercased value if it's one of `allowed`, otherwise undefined.
export function normalizeChoice(value, allowed) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return allowed.includes(v) ? v : undefined;
}

const LENGTH_TEXT = {
  banter:
    'RESPONSE LENGTH — BANTER: Write zero narration. No action beats, no scene description, no inner monologue. ' +
    'Reply with exactly one sentence of dialogue, like a fast back-and-forth conversation. Never write more than one sentence.',
  short:
    'RESPONSE LENGTH — SHORT: Keep every reply under 250 words. Be economical: advance the scene, then stop.',
  medium:
    'RESPONSE LENGTH — MEDIUM: Aim for 300 to 450 words per reply. Balance dialogue, action, and description.',
  long:
    'RESPONSE LENGTH — LONG: Aim for 450 to 650 words per reply. Develop the scene fully, with room for ' +
    'description, interiority, and layered dialogue.',
  novel:
    'RESPONSE LENGTH — NOVEL: Write at least 700 words per reply, in the manner of a full novel chapter section. ' +
    'Take your time with pacing, setting, and character interiority. Do not wrap up or rush to an ending.',
};

const NARRATION_TEXT = {
  simple:
    'NARRATION STYLE — SIMPLE: Keep narration plain and grounded. No overly dramatic or purple prose. ' +
    'Show, don\'t tell: convey emotion through concrete actions, body language, and dialogue instead of naming feelings. ' +
    'Prefer short, clear, natural sentences.',
  professional:
    'NARRATION STYLE — PROFESSIONAL: Write at the level of an award-winning published novel. Use precise, ' +
    'evocative sensory detail, varied sentence rhythm, strong subtext, and distinct character voice. ' +
    'Every line should earn its place. Show through specific, fresh detail rather than stating emotions outright.',
};

const NO_AISM_TEXT =
  'NO AI CLICHES: Avoid stock AI-writing habits. Do not use: "ministrations", "orbs" for eyes, "shivers down the spine", ' +
  '"a mix of X and Y" emotion constructions, "couldn\'t help but", "barely above a whisper", "the air was thick with", ' +
  '"testament to", "tapestry", "a symphony of", "eyes sparkling with mischief", "breath hitched", "let out a breath ' +
  'they didn\'t know they were holding", "smirk" as a default expression, or "you\'re not just X, you\'re Y" ' +
  'constructions. Do not end replies with a summary, a moral, or a question to the user. Avoid repeating the same ' +
  'sentence structure or opener across replies, and avoid the "not X, but Y" rhythm. Prefer specific, concrete wording over generic filler.';

const MARKDOWN_TEXT =
  'FORMATTING: Use consistent markdown conventions in every reply:\n' +
  '- Spoken dialogue goes in double quotes: "Like this."\n' +
  '- Narration and actions go in italics: *She crossed the room.*\n' +
  '- Inner monologue goes in italic parentheses: *(I should leave.)*\n' +
  '- Text messages, chats and phone screens go in backticks: `omw, 5 min`\n' +
  '- Sounds and onomatopoeia go in italics inside the narration: *Thud.*\n' +
  '- Whispered or emphasized words may use italics inside the quotes; shouting may use **bold** caps.\n' +
  '- Written notes, signs, letters and documents go in a blockquote (> ).\n' +
  '- Thoughts, speech, and narration must never be mixed within a single formatting span.\n' +
  'Apply these consistently; never leave narration unformatted or dialogue unquoted.';

const LIVING_WORLD_TEXT =
  'LIVING WORLD: The setting is populated and continues without the main characters. NPCs have their own lives, ' +
  'goals, moods, and conversations. Crowded places have audible, overlapping chatter, people jostling and bumping ' +
  'into each other, and background events unfolding. Weather, time of day, and ambient activity change over time. ' +
  'NPCs may react to what the characters say and do, notice things, interrupt, or pursue their own business. ' +
  'Weave this in naturally without letting it derail or overwhelm the main scene.';

const REAL_TEXTING_TEXT =
  'REALISTIC TEXTING: Whenever a character sends a text, DM, or chat message, write it the way that specific ' +
  'person would actually type it. Match their personality, age, and background: slang, abbreviations, emoticons ' +
  'or emoji, lowercase, missing punctuation, typos, run-ons, double-texting, and short bursts of several messages. ' +
  'If the character is formal or precise, they use perfect grammar and punctuation instead. Never make every ' +
  'character text in the same voice, and don\'t over-polish casual texters.';

const DIALOGUE_TEXT = {
  low:
    'DIALOGUE RATIO — LOW: Lean on narration, action, and description. Keep spoken dialogue sparse and purposeful, ' +
    'roughly a quarter of the reply or less.',
  medium:
    'DIALOGUE RATIO — MEDIUM: Balance spoken dialogue and narration roughly evenly within each reply.',
  high:
    'DIALOGUE RATIO — HIGH: Make most of each reply spoken dialogue, roughly three quarters or more. ' +
    'Keep narration brief and in service of the conversation.',
};

const PACING_TEXT = {
  slow:
    'PACING — SLOW: Let the scene breathe. Build tension and relationships gradually, linger on moments, and do not ' +
    'rush into major events, revelations, or escalations. Small beats matter. One step forward per reply, not five.',
  fast:
    'PACING — FAST: Keep the story moving. Prioritize momentum, move quickly through transitions, and let events, ' +
    'decisions, and consequences follow each other without lingering.',
};

const VARY_OPENERS_TEXT =
  'VARIETY: Never open two consecutive replies the same way. Vary the first words, sentence structure, and ' +
  'paragraph shape from reply to reply, and do not reuse phrases, descriptions, or gestures you have already used ' +
  'earlier in the conversation.';

const REALISM_TEXT =
  'REALISM: The world follows realistic rules. Actions have lasting consequences: injuries linger, fatigue builds, ' +
  'and mistakes matter. Characters only know what they have actually seen or been told, and cannot read minds. ' +
  'Physics, time, distance, and social norms apply. Characters behave like believable people, not idealized ones.';

const CONTINUITY_TEXT =
  'CONTINUITY: Track and honor every established detail: names, appearances, clothing, injuries, objects, locations, ' +
  'time of day, weather, promises, and who knows what. Never contradict earlier facts, and carry consequences forward ' +
  'from earlier replies.';

const PROACTIVE_TEXT =
  'PROACTIVE CHARACTERS: Do not wait passively for the user to drive the story. Characters and NPCs make their own ' +
  'decisions, pursue goals, introduce complications, and move the plot forward. Do not end replies by simply handing ' +
  'the scene back; always give the user something concrete to react to.';

// Builds the combined directive text for a cfg, or undefined if nothing is on.
export function buildRoleplayDirectives(cfg = {}) {
  const parts = [];

  const length = normalizeChoice(cfg.responseLength, RESPONSE_LENGTHS);
  if (length) parts.push(LENGTH_TEXT[length]);

  const narration = normalizeChoice(cfg.narrationMode, NARRATION_MODES);
  // Banter has no narration at all, so a narration style would contradict it.
  if (narration && length !== 'banter') parts.push(NARRATION_TEXT[narration]);

  if (cfg.noAism) parts.push(NO_AISM_TEXT);
  if (cfg.forceMarkdown) parts.push(MARKDOWN_TEXT);
  if (cfg.livingWorld && length !== 'banter') parts.push(LIVING_WORLD_TEXT);
  if (cfg.realTexting) parts.push(REAL_TEXTING_TEXT);

  // Banter is all dialogue by definition, so a dialogue ratio would conflict.
  const ratio = normalizeChoice(cfg.dialogueRatio, DIALOGUE_RATIOS);
  if (ratio && length !== 'banter') parts.push(DIALOGUE_TEXT[ratio]);

  // 'normal' pacing is the model's default, so it adds no directive.
  const pacing = normalizeChoice(cfg.pacing, PACINGS);
  if (pacing && pacing !== 'normal') parts.push(PACING_TEXT[pacing]);

  if (cfg.varyOpeners) parts.push(VARY_OPENERS_TEXT);
  if (cfg.realism) parts.push(REALISM_TEXT);
  if (cfg.continuity) parts.push(CONTINUITY_TEXT);
  if (cfg.proactive) parts.push(PROACTIVE_TEXT);

  if (!parts.length) return undefined;
  return 'ROLEPLAY STYLE DIRECTIVES (follow these in every reply):\n\n' + parts.join('\n\n');
}

// Appends directive text to an existing Gemini systemInstruction (which may
// be undefined). Returns undefined if there is nothing to send at all.
export function mergeSystemInstruction(base, extraText) {
  if (!extraText) return base;
  if (!base) return { parts: [{ text: extraText }] };
  return { ...base, parts: [...(base.parts || []), { text: extraText }] };
}
