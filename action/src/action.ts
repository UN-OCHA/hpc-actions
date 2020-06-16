
import * as child_process from 'child_process';
import fs from 'fs';
import git from 'isomorphic-git';
import * as path from 'path';
import { promisify } from 'util';
import { Webhooks } from '@octokit/webhooks';

import { Env, Config, getConfig } from './config';

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
  /**
   * Custom logger to use instead of console
   */
  logger?: {
    log: (...args: any[]) => void;
  }
}

type GitHubEvent = {
  name: 'push',
  payload: Webhooks.WebhookPayloadPush
}

const BRANCH_EXTRACT = /^refs\/heads\/(.*)$/;

type Mode =
  | 'env-production'
  | 'env-staging'
  | 'env-development'
  | 'hotfix'
  | 'release'
  | 'develop'
  | 'other';

const determineMode = (config: Config, branch: string): Mode => {
  if (branch === 'env/prod') {
    return 'env-production';
  } else if (branch === config.stagingEnvironmentBranch) {
    return 'env-staging';
  } else if (config.developmentEnvironmentBranches.indexOf(branch) > -1) {
    return 'env-development';
  } else if (branch.startsWith('env/')) {
    throw new Error(
      `Invalid development branch: ${branch}, ` +
      `must be one of: ${config.developmentEnvironmentBranches.join(', ')}`
    );
  } else if (branch.startsWith('hotfix/')) {
    return 'hotfix';
  } else if (branch.startsWith('release/')) {
    return 'release';
  } else if (branch === 'develop') {
    return 'develop';
  } else {
    return 'other';
  }
}

export const runAction = async (
  {
    env,
    dir = process.cwd(),
    logger = console,
  }: Params
) => {

  const config = await getConfig(env);

  // Get event information

  if (!env.GITHUB_EVENT_NAME)
    throw new Error('Expected GITHUB_EVENT_NAME');
  if (!env.GITHUB_EVENT_PATH)
    throw new Error('Expected GITHUB_EVENT_PATH');
  
  let event: GitHubEvent;
  
  if (env.GITHUB_EVENT_NAME === 'push') {
    event = {
      name: 'push',
      payload: JSON.parse((await fs.promises.readFile(env.GITHUB_EVENT_PATH)).toString())
    };
    if (event?.payload?.ref?.startsWith('refs/tags/')) {
      logger.log(`Push is for tag, skipping action`);
      return;
    }
  } else {
    throw new Error(`Unsupported GITHUB_EVENT_NAME: ${env.GITHUB_EVENT_NAME}`);
  }

  if (event.name === 'push') {

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

    // Get branch name for event
    const branchExtract = BRANCH_EXTRACT.exec(event.payload.ref);
    if (!branchExtract) {
      throw new Error('Unable to extract branch name from ref');
    }
    const branch = branchExtract[1];

    logger.log(`Handling push to branch ${branch}`);

    const mode = determineMode(config, branch);

    if (mode === 'env-production' || mode === 'env-staging') {
      logger.log(`Checking if there is an existing tag for v${version}`);
    }

  }
}
