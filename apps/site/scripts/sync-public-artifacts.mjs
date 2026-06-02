import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const startDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicFilePattern = /^(README\.md|summary\.json|public-[\w-]+\.(?:jsonl|json)|restart-recovery-notes\.md)$/;

function findRepoRoot(dir) {
  let current = dir;
  while (true) {
    if (existsSync(path.join(current, 'docs/artifacts'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function copyPublicArtifacts(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) return;
  mkdirSync(targetDir, { recursive: true });

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyPublicArtifacts(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile() && publicFilePattern.test(entry.name)) {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

const repoRoot = findRepoRoot(startDir);
if (repoRoot === undefined) {
  console.log('No repo-level docs/artifacts directory found; keeping existing public artifacts.');
  process.exit(0);
}

const sourceRoot = path.join(repoRoot, 'docs/artifacts');
const targetRoot = path.join(startDir, 'public/docs/artifacts');

if (existsSync(targetRoot)) {
  rmSync(targetRoot, { recursive: true, force: true });
}

copyPublicArtifacts(sourceRoot, targetRoot);

if (existsSync(targetRoot) && statSync(targetRoot).isDirectory()) {
  console.log(`Synced public artifacts to ${path.relative(repoRoot, targetRoot)}`);
}
