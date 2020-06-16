import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

const ROOT_TMP_DIR = path.join(tmpdir(), Math.random().toString(36).substr(2));

export const rootTmpDir = () => ROOT_TMP_DIR;

export const tmpConfigFilePath = (filename: string) => 
  path.join(ROOT_TMP_DIR, path.basename(filename) + '.config.json');

export const createTmpDir = async () => {
  const dir = path.join(ROOT_TMP_DIR, Math.random().toString(36).substr(2));
  await fs.mkdir(dir);
  return dir;
}
