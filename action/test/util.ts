import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

import { Logger } from '../src/util/interfaces';

const ROOT_TMP_DIR = path.join(tmpdir(), Math.random().toString(36).substr(2));

export const rootTmpDir = () => ROOT_TMP_DIR;

export const tmpConfigFilePath = (filename: string) => 
  path.join(ROOT_TMP_DIR, path.basename(filename) + '.config.json');

export const tmpEventFilePath = (filename: string) =>
  path.join(ROOT_TMP_DIR, path.basename(filename) + '.event.json');

export const createTmpDir = async () => {
  const dir = path.join(ROOT_TMP_DIR, 'hpc-actions-test-' + Math.random().toString(36).substr(2));
  await fs.mkdir(dir);
  return dir;
}

export const newLogger = () => ({
  log: jest.fn(),
  error: jest.fn(),
});

export const newInterleavedLogger = () => {
  const fn = jest.fn();
  return {
    fn,
    log: (...args: any[]) => fn('[stdout]', ...args),
    error: (...args: any[]) => fn('[stderr]', ...args),
  };
}