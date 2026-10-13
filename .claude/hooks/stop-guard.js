#!/usr/bin/env node
// Stop and SubagentStop guard for the Return App project.
//
// Claude Code sends the hook payload on stdin. It includes stop_hook_active, which is
// true when this stop was already blocked once and the agent is continuing.
// The project goal state is in .claude/goal-status.json.
//
// Exit 0 = allow the stop.
// Exit 2 = block once. The reason on stderr is fed back to the agent.
//
// Rules, in order:
//  1. stop_hook_active is true: allow. A block has already been answered this turn.
//  2. No status file, or status is not IN_PROGRESS (BLOCKED, COMPLETED, FAILED): allow.
//     BLOCKED means external input is needed. The turn must end, not loop.
//  3. IN_PROGRESS with an empty next_action: allow. There is no concrete next step.
//  4. IN_PROGRESS with a next_action: block once. If the same next_action is recorded
//     more than MAX_REPEATS times in a row, the status is set to BLOCKED and the stop is allowed.
//
// Limits: this guard only governs Stop hooks configured in this project. It cannot
// change the /goal check that Claude Code runs itself. Use /goal clear to stop that one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_REPEATS = 2;
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const statusPath = path.join(projectDir, '.claude', 'goal-status.json');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function allow() {
  process.exit(0);
}

function block(reason) {
  // Let stderr flush before exiting, so the reason reaches the agent.
  process.stderr.write(reason + '\n', () => process.exit(2));
}

function readPayload() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function readStatus() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeStatus(status) {
  try {
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n');
  } catch {
    // Best effort. A failed status write must never turn into a blocked stop.
  }
}

function main() {
  const payload = readPayload();
  if (payload.stop_hook_active === true) allow();

  const status = readStatus();
  if (!status || status.status !== 'IN_PROGRESS') allow();

  const nextAction = typeof status.next_action === 'string' ? status.next_action.trim() : '';
  if (!nextAction) allow();

  const signature = crypto.createHash('sha1').update(nextAction).digest('hex');
  const repeats = status.repeat_signature === signature ? (Number(status.repeat_count) || 0) + 1 : 1;

  if (repeats > MAX_REPEATS) {
    const blockers = Array.isArray(status.blockers) ? status.blockers : [];
    writeStatus({
      ...status,
      status: 'BLOCKED',
      blockers: [...blockers, `No progress after ${repeats - 1} identical attempts at: ${nextAction}`],
      next_action: '',
      repeat_signature: '',
      repeat_count: 0,
      updated_at: today(),
    });
    allow();
  }

  writeStatus({ ...status, repeat_signature: signature, repeat_count: repeats, updated_at: today() });
  block(`The project goal is IN_PROGRESS. Next action: ${nextAction}`);
}

main();
