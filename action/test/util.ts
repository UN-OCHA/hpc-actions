import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const ROOT_TMP_DIR = path.join(
  tmpdir(),
  Math.random().toString(36).substring(2)
);

export const rootTmpDir = () => ROOT_TMP_DIR;

export const tmpConfigFilePath = (filename: string) =>
  path.join(ROOT_TMP_DIR, `${path.basename(filename)}.config.json`);

export const tmpEventFilePath = (filename: string) =>
  path.join(ROOT_TMP_DIR, `${path.basename(filename)}.event.json`);

export const createTmpDir = async () => {
  const dir = path.join(
    ROOT_TMP_DIR,
    `hpc-actions-test-${Math.random().toString(36).substring(2)}`
  );
  await fs.mkdir(dir);
  return dir;
};

export const newLogger = () => ({
  log: jest.fn(),
  error: jest.fn(),
});

export const newInterleavedLogger = () => {
  const fn = jest.fn();
  return {
    fn,
    log: (...args: unknown[]) => fn('[stdout]', ...args),
    error: (...args: unknown[]) => fn('[stderr]', ...args),
  };
};
