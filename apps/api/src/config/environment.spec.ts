import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  vi.resetModules();
  vi.restoreAllMocks();
});

describe.sequential('process environment loading', () => {
  test('loads package-local then workspace-root .env without overriding the OS environment', async () => {
    const fixture = await createWorkspaceFixture({
      packageEnv: 'DATABASE_URL=postgresql://package\nPORT=3100\n',
      rootEnv: 'DATABASE_URL=postgresql://root\nRECONCILIATION_CRON=*/7 * * * *\n',
    });
    process.chdir(fixture.packageDirectory);
    delete process.env.DATABASE_URL;
    delete process.env.RECONCILIATION_CRON;
    process.env.PORT = '4200';

    try {
      const { environmentFileCandidates, loadEnvironment } = await import('./environment.js');
      const candidates = environmentFileCandidates();
      loadEnvironment(candidates);

      expect(candidates).toEqual([
        join(fixture.packageDirectory, '.env'),
        join(fixture.workspaceDirectory, '.env'),
      ]);
      expect(process.env.DATABASE_URL).toBe('postgresql://package');
      expect(process.env.RECONCILIATION_CRON).toBe('*/7 * * * *');
      expect(process.env.PORT).toBe('4200');
    } finally {
      process.chdir(ORIGINAL_CWD);
      await rm(fixture.workspaceDirectory, { recursive: true, force: true });
    }
  });

  test('loads the workspace root environment before scheduler metadata is evaluated', async () => {
    const fixture = await createWorkspaceFixture({
      rootEnv: 'DATABASE_URL=postgresql://root\nRECONCILIATION_CRON=*/11 * * * *\n',
    });
    process.chdir(fixture.packageDirectory);
    delete process.env.DATABASE_URL;
    delete process.env.RECONCILIATION_CRON;

    try {
      await import('./load-environment.js');
      const { ReconciliationScheduler } = await import(
        '../finance/settlement/reconciliation.scheduler.js'
      );
      const options = Reflect.getMetadata(
        'SCHEDULE_CRON_OPTIONS',
        ReconciliationScheduler.prototype.reconcileDueUsers,
      ) as { cronTime?: string } | undefined;

      expect(process.env.DATABASE_URL).toBe('postgresql://root');
      expect(options?.cronTime).toBe('*/11 * * * *');
    } finally {
      process.chdir(ORIGINAL_CWD);
      await rm(fixture.workspaceDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  test('entrypoints load the environment before importing the app or reading DATABASE_URL', async () => {
    const [mainSource, migratorSource] = await Promise.all([
      readFile(join(ORIGINAL_CWD, 'src', 'main.ts'), 'utf8'),
      readFile(join(ORIGINAL_CWD, 'src', 'database', 'migrator.ts'), 'utf8'),
    ]);

    expect(mainSource.indexOf("import './config/load-environment'")).toBeGreaterThanOrEqual(0);
    expect(mainSource.indexOf("import './config/load-environment'"))
      .toBeLessThan(mainSource.indexOf("import('./app.module.js')"));
    expect(migratorSource.indexOf("import '../config/load-environment'")).toBeGreaterThanOrEqual(0);
    expect(migratorSource.indexOf("import '../config/load-environment'"))
      .toBeLessThan(migratorSource.indexOf('const url = process.env.DATABASE_URL'));
  });

});

async function createWorkspaceFixture(input: { packageEnv?: string; rootEnv?: string }) {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), 'budget-flow-environment-'));
  const packageDirectory = join(workspaceDirectory, 'apps', 'api');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(workspaceDirectory, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n', 'utf8');
  if (input.packageEnv !== undefined) {
    await writeFile(join(packageDirectory, '.env'), input.packageEnv, 'utf8');
  }
  if (input.rootEnv !== undefined) {
    await writeFile(join(workspaceDirectory, '.env'), input.rootEnv, 'utf8');
  }
  return { workspaceDirectory, packageDirectory };
}
