#!/usr/bin/env bun
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// Runs after the develop agent (codex) inside the agent-runner job, which — unlike the codex
// sandbox — has network. For a UI product, it installs a headless browser, runs the agent's
// Playwright specs (which both verify behaviour and capture screenshots), and harvests the
// screenshots into the run's artifacts dir so they are bundled and posted as PR evidence.
// It is non-blocking: develop still produces a PR + whatever evidence even if the specs fail; the
// CI gate enforces correctness. On a repo with no UI/Playwright harness it cleanly no-ops.

const SCREENSHOT_DIRS = ['screenshots', 'test-results', 'playwright-report'];

export function detectUi(root: string): boolean {
  if (readdirSync(root).some((name) => /^playwright\.config\.(ts|js|mjs|cjs)$/.test(name))) return true;
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    if (['screenshots', 'e2e', 'test:e2e'].some((s) => s in scripts)) return true;
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return '@playwright/test' in deps || 'playwright' in deps;
  } catch {
    return false;
  }
}

export function chooseCommand(scripts: Record<string, string>): string {
  if ('screenshots' in scripts) return 'bun run screenshots';
  if ('test:e2e' in scripts) return 'bun run test:e2e';
  if ('e2e' in scripts) return 'bun run e2e';
  return 'bunx playwright test';
}

export function collectScreenshots(root: string, dirs = SCREENSHOT_DIRS): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (/\.(png|jpg|jpeg)$/i.test(entry)) found.push(abs);
    }
  };
  for (const d of dirs) walk(join(root, d));
  return found.sort();
}

function packageScripts(root: string): Record<string, string> {
  try {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const taskDir = process.env.OSS_AGENT_TASK_DIR;
  if (!taskDir) {
    process.stdout.write('visual-verify: OSS_AGENT_TASK_DIR not set; skipping\n');
    return;
  }
  const artifacts = join(taskDir, 'artifacts');
  mkdirSync(artifacts, { recursive: true });

  if (!detectUi(root)) {
    writeFileSync(join(artifacts, 'visual-verify.json'), `${JSON.stringify({ schema: 'open-autonomy.visual-verify.v1', ran: false, reason: 'no UI / Playwright harness detected' }, null, 2)}\n`);
    process.stdout.write('visual-verify: no UI/Playwright harness detected; skipped\n');
    return;
  }

  let installed = true;
  try {
    execSync('bunx playwright install --with-deps chromium', { stdio: 'inherit' });
  } catch {
    installed = false;
    process.stderr.write('visual-verify: playwright browser install failed; continuing\n');
  }

  const command = chooseCommand(packageScripts(root));
  let exitCode = 0;
  try {
    execSync(command, { stdio: 'inherit' });
  } catch (error) {
    exitCode = (error as { status?: number }).status ?? 1;
    process.stderr.write(`visual-verify: "${command}" exited ${exitCode}\n`);
  }

  const shots = collectScreenshots(root);
  const harvested: string[] = [];
  let index = 0;
  for (const shot of shots) {
    const target = join(artifacts, `screenshot-${String(index).padStart(2, '0')}-${basename(shot)}`);
    try {
      copyFileSync(shot, target);
      harvested.push(basename(target));
      index += 1;
    } catch {
      /* skip unreadable */
    }
  }

  writeFileSync(
    join(artifacts, 'visual-verify.json'),
    `${JSON.stringify({ schema: 'open-autonomy.visual-verify.v1', ran: true, browser_installed: installed, command, exit_code: exitCode, screenshots: harvested }, null, 2)}\n`,
  );
  process.stdout.write(`visual-verify: ran "${command}" (exit ${exitCode}); harvested ${harvested.length} screenshot(s)\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    // Never fail the develop step on visual-verify problems; CI is the gate.
    process.stderr.write(`visual-verify error: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}
