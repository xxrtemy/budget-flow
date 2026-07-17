import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function environmentFileCandidates(
  workingDirectory = process.cwd(),
): [packageLocal: string, workspaceRoot: string] {
  const workspaceDirectory = findWorkspaceDirectory(workingDirectory);
  return [
    join(workspaceDirectory, 'apps', 'api', '.env'),
    join(workspaceDirectory, '.env'),
  ];
}

export function loadEnvironment(files = environmentFileCandidates()): void {
  for (const file of new Set(files)) {
    try {
      process.loadEnvFile(file);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

function findWorkspaceDirectory(workingDirectory: string): string {
  let directory = resolve(workingDirectory);

  while (true) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Cannot locate pnpm workspace from ${workingDirectory}`);
    }
    directory = parent;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
