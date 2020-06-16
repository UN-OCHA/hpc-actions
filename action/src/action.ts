import fs from 'fs';
import { Env, getConfig } from './config';
import git from 'isomorphic-git';

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

  const c = await getConfig(env);

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

  return 'hello world';
}
