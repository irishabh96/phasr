const assert = require('node:assert/strict');
const test = require('node:test');

const formatter = require('./terminal_formatter.js');

test('snapshot: wraps long skill item with hanging indentation at 80/100/120 columns', () => {
  const line = '- skill-creator: Guide for creating effective skills. This skill should be used when users want to create a new skill (file: /Users/rishabh/.codex/skills/.system/skill-creator/SKILL.md)';

  const snapshots = {
    80: `- skill-creator: Guide for creating effective skills. This skill should be used\n  when users want to create a new skill\n  path: /Users/rishabh/.codex/skills/.system/skill-creator/SKILL.md`,
    100: `- skill-creator: Guide for creating effective skills. This skill should be used when users want to\n  create a new skill\n  path: /Users/rishabh/.codex/skills/.system/skill-creator/SKILL.md`,
    120: `- skill-creator: Guide for creating effective skills. This skill should be used when users want to create a new skill\n  path: /Users/rishabh/.codex/skills/.system/skill-creator/SKILL.md`,
  };

  for (const width of [80, 100, 120]) {
    assert.equal(formatter.formatStructuredLine(line, width), snapshots[width]);
  }
});

test('long filesystem path is rendered on dedicated path line with safe truncation', () => {
  const line = '- x: desc (file: /Users/rishabh/.superset/worktrees/Phasr/build-a-desktop-first-dark-mode-developer-tool-ui/provider-logic-or-existing-workflows.-the-app-sho/SKILL.md)';
  const output = formatter.formatStructuredLine(line, 40);

  assert.equal(output, '- x: desc\n  path: /Users/rishabh/...p-sho/SKILL.md');
});

test('removes background ANSI paint from blank lines', () => {
  const input = '\x1b[48;5;236m          \x1b[0m\n';
  const output = formatter.formatChunk(input, 100);

  assert.equal(output, '          \x1b[0m\n');
  assert.equal(/\x1b\[[0-9;]*48;?/.test(output), false);
});

test('keeps empty sections compact without phantom rows', () => {
  const input = 'When Skills Trigger\n\n';
  const output = formatter.formatChunk(input, 100);

  assert.equal(output, 'When Skills Trigger\n\n');
});

test('wraps numbered bullets with hanging indent', () => {
  const line = '1. After deciding to use a skill, open its SKILL.md. Read only enough to follow the workflow.';
  const output = formatter.formatStructuredLine(line, 60);

  assert.equal(output, '1. After deciding to use a skill, open its SKILL.md. Read\n   only enough to follow the workflow.');
});
