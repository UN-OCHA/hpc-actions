
import * as child_process from 'child_process';
import fs from 'fs';
import git from 'isomorphic-git';
import * as path from 'path';
import { promisify } from 'util';
import { Webhooks } from '@octokit/webhooks';

import { Env, Config, getConfig } from './config';
import { DockerInit, REAL_DOCKER } from './docker';

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
    error: (...args: any[]) => void;
  }
  /**
   * Interface to interact with docker
   */
  dockerInit?: DockerInit;
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
    dockerInit = REAL_DOCKER
  }: Params
) => {

  const info = (message: string) => logger.log(`##[info] ${message}`);

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
      info(`Push is for tag, skipping action`);
      return;
    }
  } else {
    throw new Error(`Unsupported GITHUB_EVENT_NAME: ${env.GITHUB_EVENT_NAME}`);
  }

  if (event.name === 'push') {

    const docker = dockerInit(config.docker);

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

    info(`Handling push to branch ${branch}`);

    const mode = determineMode(config, branch);

    // Check that the correct branch is checked out,
    // and get the current commit info
    const currentBranch = await git.currentBranch({fs, dir});
    if (!currentBranch) {
      throw new Error('no branch is currently checked out');
    } else if (currentBranch !== branch) {
      throw new Error('incorrect branch currently checked-out');
    }
    const headSha = await git.resolveRef({fs, dir, ref: currentBranch});
    const head = await git.readCommit({ fs, dir, oid: headSha});

    // Handle the push as appropriate for the given branch

    if (mode === 'env-production' || mode === 'env-staging') {
      const tag = `v${version}`;
      info(`Checking if there is an existing tag for ${tag}`);
      const existing =
        await exec(`git fetch ${remote.remote} ${tag}:${tag}`, { cwd: dir })
          .then(() => true)
          .catch(err => {
            if (err.stderr.indexOf(`fatal: couldn't find remote ref`) > -1) {
              return false;
            } else {
              throw err;
            }
          });

      /**
       * The commit sha for the tag after it's been created or checked
       */
      let tagSha: string;
      if (existing) {
        // Check that the tree hash of the existing tag matches
        // (i.e. the content hasn't changed without changing the version)
        info(`The tag ${tag} already exists, checking that tree hasn't changed`);
        tagSha = await git.resolveRef({ fs, dir, ref: `refs/tags/${tag}` });
        const tagHead = await git.readCommit({ fs, dir, oid: tagSha });
        if (tagHead.commit.tree !== head.commit.tree) {
          throw new Error(`New push to ${branch} without bumping version`);
        } else {
          if (tagHead.oid === head.oid) {
            info(`The tag is for the current commit, okay to continue`);
          } else {
            info(`The current tree matches the existing tag, okay to continue`);
          }
        }
      } else {
        // Create and push the tag
        info(`Creating and pushing new tag ${tag}`);
        await git.tag({ fs, dir, ref: tag });
        tagSha = await git.resolveRef({ fs, dir, ref: `refs/tags/${tag}` });
        await exec(`git push ${remote.remote} ${tag}`, { cwd: dir });
      }

      // Check whether there is an existing docker image, and build if needed

      info(`Checking for existing docker image with tag ${tag}`);
      const image = await docker.checkExistingImage(tag);

      if (image) {
        // An image already exists, make sure it was built using the same files
        info(`Image already exists, checking it was built with same git tree`);
        if (image.treeSha !== head.commit.tree) {
          throw new Error(`Image was built with different tree, aborting`);
        } else {
          info(`Image was built with same tree, no need to run build again`);
        }
      } else {
        info(`Image with tag ${tag} does not yet exist, building image`);
        await docker.runBuild(
          tag,
          {
            commitSha: head.oid,
            treeSha: head.commit.tree,
          }
        );
        info(`Image built, checking tag is unchanged`);
        await git.deleteRef({fs, dir, ref: `refs/tags/${tag}`});
        await exec(`git fetch ${remote.remote} ${tag}:${tag}`, { cwd: dir });
        const newTagSha = await git.resolveRef({ fs, dir, ref: `refs/tags/${tag}` });
        if (newTagSha !== tagSha) {
          throw new Error('Tag has changed, aborting');
        } else {
          info(`Tag is unchanged, okay to continue`);
        }
        info(`Pushing image to docker repository`);
        await docker.pushImage(tag);
        info(`Image Pushed`);
      }

      // Run CI Checks

      info(`Running CI Checks`);

      for (const cmd of config.ci) {
        info(`Running: ${cmd}`);
        const p = child_process.execFile('sh', ['-c', cmd], {
          cwd: dir
        });
        const buffer = {
          stderr: '',
          stdout: ''
        };
        for (const stream of ['stdout', 'stderr'] as const) {
          const handle = (data: string) => {
            buffer[stream] += data;
            let nextBreak: number;
            while ((nextBreak = buffer[stream].indexOf('\n')) > -1) {
              const ready = buffer[stream].substr(0, nextBreak);
              buffer[stream] = buffer[stream].substr(nextBreak + 1);
              logger[stream === 'stdout' ? 'log' : 'error'](ready);
            }
          }
          p[stream]?.on('data', handle);
        }
        await new Promise((resolve, reject) =>
          p.on('exit', code => {
            // Print any remaining data
            for (const stream of ['stdout', 'stderr'] as const) {
              if (buffer[stream] !== '') {
                logger[stream === 'stdout' ? 'log' : 'error'](buffer[stream]);
              }
            }
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`CI command ${cmd} exited with exit code ${code}`));
            }
          })
        );
      };

      info(`CI Checks Complete`);


    }

  }
}
