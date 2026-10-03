/**
 * Locate and load the `.env` file(s).
 *
 * `dotenv.config()` on its own resolves relative to `process.cwd()`, and pnpm
 * runs a package script with the cwd set to that package — so a bare call from
 * `@hims/api` reads `apps/api/.env` and silently ignores the `.env` at the
 * repository root, which is where the README (and habit) puts it. The symptom
 * is a confusing "invalid environment configuration" immediately after
 * following the setup instructions correctly.
 *
 * Precedence, highest first:
 *
 *   1. the real process environment — so CI and container secrets always win
 *   2. apps/api/.env   — an optional per-package override
 *   3. <repo root>/.env — the normal place, and what the README documents
 *
 * dotenv never overwrites a variable that is already set, so loading in that
 * order gives exactly this precedence without any override flags (which would
 * also clobber genuine process-environment values).
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/** Markers that identify the workspace root, in order of confidence. */
const ROOT_MARKERS = ['pnpm-workspace.yaml', 'pnpm-lock.yaml'];

function findRepoRoot(startDir: string): string | null {
  let current = resolve(startDir);

  // Walk up until a marker is found or the filesystem root is reached.
  for (let depth = 0; depth < 10; depth += 1) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

export interface LoadedEnv {
  /** Files that existed and were read, highest precedence first. */
  loaded: string[];
  repoRoot: string | null;
  packageRoot: string;
}

export function loadEnv(): LoadedEnv {
  // Anchored to this module, not to cwd, so it behaves the same whether the
  // process was started by pnpm, by tsx directly, or from a built dist/.
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const repoRoot = findRepoRoot(packageRoot);

  const candidates = [
    join(packageRoot, '.env'),
    ...(repoRoot && repoRoot !== packageRoot ? [join(repoRoot, '.env')] : []),
  ];

  const loaded: string[] = [];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    dotenv.config({ path });
    loaded.push(path);
  }

  return { loaded, repoRoot, packageRoot };
}
