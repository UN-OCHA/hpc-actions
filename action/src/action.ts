
import * as child_process from 'child_process';
import fs from 'fs';
import git from 'isomorphic-git';
import * as path from 'path';
import { promisify } from 'util';

import { Env, getConfig } from './config';

const exec = promisify(child_process.exec);

interface Params {
  /**
   * The environment variables received by the process
   */
  env: Env;
  /**
   * Directory the action is running in (usually the root of the repo)
   */
  dir?: string;
}

export const runAction = async (
  {
    env,
    dir = process.cwd(),
  }: Params
) => {

  const config = await getConfig(env);

  // Get remote information

  const remotes = await git.listRemotes({
    fs,
    dir
  }).catch(err => {
    // Assume that not in git repository
    throw new Error('Action not run within git repository');
  });
  if (remotes.length !== 1) {
    throw new Error('Exactly 1 remote expected in repository');
  }
  const remote = remotes[0];

  // Get current version information

  let version: string;
  if (config.repoType === 'node') {
    const pkg =
      await fs.promises.readFile(path.join(dir, 'package.json'))
      .catch(err => Promise.reject(new Error(
        `Unable to read version from package.json: ${err.message}`
      )));
    let json: any;
    try {
      json = JSON.parse(pkg.toString());
    } catch (err) {
      throw new Error(
        `Unable to read version from package.json: Invalid JSON: ${err.message}`
      );
    }
    version = json.version;
    if (typeof version !== 'string') {
      throw new Error(`Invalid version in package.json`);
    }
  } else {
    throw new Error('Unsupported repo type: ' + config.repoType);
  }

  

  return 'hello world';
}
