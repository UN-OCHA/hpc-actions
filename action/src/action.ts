
import * as child_process from 'child_process';
import fs from 'fs';
import git from 'isomorphic-git';
import * as path from 'path';
import { promisify } from 'util';
import { Webhooks } from '@octokit/webhooks';

import { execAndPipeOutput } from './util/child_process';

import { Env, Config, getConfig } from './config';
import { DockerInit, REAL_DOCKER } from './docker';
import { GitHubInit, REAL_GITHUB, PullRequest } from './github';

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
  /**
   * Interface to interact with github
   */
  gitHubInit?: GitHubInit;
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

export class NoPullRequestError extends Error {}

export const runAction = async (
  {
    env,
    dir = process.cwd(),
    logger = console,
    dockerInit = REAL_DOCKER,
    gitHubInit = REAL_GITHUB,
  }: Params
) => {

  const info = (message: string) => logger.log(`##[info] ${message}`);

  const config = await getConfig(env);

  // Get event information

  if (!env.GITHUB_EVENT_NAME)
    throw new Error('Expected GITHUB_EVENT_NAME');
  if (!env.GITHUB_EVENT_PATH)
    throw new Error('Expected GITHUB_EVENT_PATH');
  if (!env.GITHUB_REPOSITORY)
    throw new Error('Expected GITHUB_REPOSITORY');

  // Get docker credentials
  if (!env.DOCKER_USERNAME)
    throw new Error('Expected DOCKER_USERNAME');
  if (!env.DOCKER_PASSWORD)
    throw new Error('Expected DOCKER_PASSWORD');

  // Get GitHub credentials
  if (!env.GITHUB_TOKEN)
    throw new Error('Expected GITHUB_TOKEN');

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

  const github = gitHubInit({
    githubRepo: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
  });

  if (event.name === 'push') {

    /**
     * What is the path of the file that specifies the version?
     */
    const versionFilePath = (repoType: 'node') =>
      repoType === 'node' ? 'package.json' : 'UNKNOWN';

    const readRefShaAndVersion = async (ref?: string): Promise<{
      sha: string;
      version: string;
    }> => {
      const sha = await git.resolveRef({ fs, dir, ref: ref || 'HEAD' });
      if (config.repoType === 'node') {
        const pkg = await git.readBlob({
          fs,
          dir,
          oid: sha,
          filepath: versionFilePath(config.repoType)
        }).catch(err => {
          throw new Error(
            `Unable to read version from package.json: File not found in commit ${sha}`
          );
        });
        let json: any;
        try {
          json = JSON.parse(new TextDecoder("utf-8").decode(pkg.blob));
        } catch (err) {
          throw new Error(
            `Unable to read version from package.json: Invalid JSON: ${err.message}`
          );
        }
        const version = json.version;
        if (typeof version !== 'string') {
          throw new Error(`Invalid version in package.json`);
        }
        return {sha, version};
      } else {
        throw new Error('Unsupported repo type: ' + config.repoType);
      }
    }

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

    const headShaAndVersion = await readRefShaAndVersion();
    const version = headShaAndVersion.version;

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
    const head = await git.readCommit({ fs, dir, oid: headShaAndVersion.sha});

    const buildAndPushDockerImage = async (
      opts: {
        env: { DOCKER_USERNAME: string, DOCKER_PASSWORD: string },
        /**
         * How should the registry be checked for existing images with the
         * same tag before building a new one?
         *
         * * `check-tree`: if the image doesn't yet exist, build it, if it does,
         *   check to see that it was built with the same git tree sha. If it
         *   was, finish, if not, throw an error.
         * * `overwrite`: Don't check the registry, just build and push a new
         *   image.
         */
        checkBehaviour: 'check-tree' | 'overwrite',
        /**
         * Tag to use when building and pushing the docker image
         */
        tag: string,
        /**
         * If defined,
         * check that the given tag has this sha in the upstream repo
         * before pushing the image, and throw an error if it's changed.
         *
         * This is a safeguard against pushing different images with the same tag
         */
        checkTagSha?: string,
      }
    ) => {
      const { tag, checkBehaviour } = opts;
      info(`Logging in to docker`);
      const docker = dockerInit(config.docker);
      await docker.login({
        user: opts.env.DOCKER_USERNAME,
        pass: opts.env.DOCKER_PASSWORD
      });

      if (checkBehaviour === 'check-tree') {
        info(`Checking for existing docker image with tag ${tag}`);
        const imagePulled = await docker.pullImage(tag, logger);
        const image = imagePulled && await docker.getMetadata(tag);

        if (image) {
          // An image already exists, make sure it was built using the same files
          info(`Image already exists, checking it was built with same git tree`);
          if (image.treeSha !== head.commit.tree) {
            throw new Error(`Image was built with different tree, aborting`);
          } else {
            info(`Image was built with same tree, no need to run build again`);
            return;
          }
        }
      }
      if (checkBehaviour === 'check-tree') {
        info(`Image with tag ${tag} does not yet exist, building image`);
      } else if (checkBehaviour === 'overwrite') {
        info(`Skipping check for existing image with tag ${tag}, building new image`);
      }
      await docker.runBuild({
        tag,
        meta: {
          commitSha: head.oid,
          treeSha: head.commit.tree,
        },
        cwd: dir,
        logger
      });
      if (opts.checkTagSha) {
        info(`Image built, checking tag is unchanged`);
        await git.deleteRef({ fs, dir, ref: `refs/tags/${tag}` });
        await exec(`git fetch ${remote.remote} ${tag}:${tag}`, { cwd: dir });
        const newTagSha = await git.resolveRef({ fs, dir, ref: `refs/tags/${tag}` });
        if (newTagSha !== opts.checkTagSha) {
          throw new Error('Tag has changed, aborting');
        } else {
          info(`Tag is unchanged, okay to continue`);
        }
      } else {
        info(`Image built`);
      }
      info(`Pushing image to docker repository`);
      await docker.pushImage(tag);
      info(`Image Pushed`);
    }

    const runCICommands = async () => {
      info(`Running CI Checks`);

      for (const command of config.ci) {
        info(`Running: ${command}`);
        await execAndPipeOutput({ command, cwd: dir, logger });
      };

      info(`CI Checks Complete`);
    }

    const getUniquePullRequest = async () => {
      const prs = await github.getOpenPullRequests({ branch });
      if (prs.data.length === 0) {
        throw new NoPullRequestError(
          `The branch ${branch} has no pull requests open yet, ` +
          `so it is not possible to run this workflow.`
        );
      } else if (prs.data.length > 1) {
        throw new Error(
          `Multiple pull requests for branch ${branch} are open, ` +
          `so it is not possible to run this workflow.`
        );
      } else {
        return prs.data[0];
      }
    }

    const failWithPRComment = async (opts: {
      pullRequest: PullRequest,
      comment: string,
      error: string,
    }) => {
      const { pullRequest, comment, error} = opts;
      github.reviewPullRequest({
        pullRequestNumber: pullRequest.number,
        body: comment,
        state: 'reject',
      });
      throw new Error(error);
    }

    /**
     * Try and fetch a specific tag from the remote,
     * and return true if it exists and was successful
     */
    const fetchTag = (tag: string) =>
      exec(`git fetch ${remote.remote} ${tag}:${tag}`, { cwd: dir })
        .then(() => true)
        .catch(err => {
          if (err.stderr.indexOf(`fatal: couldn't find remote ref`) > -1) {
            return false;
          } else {
            throw err;
          }
        });

    // Handle the push as appropriate for the given branch

    if (mode === 'env-production' || mode === 'env-staging') {
      const tag = `v${version}`;
      info(`Checking if there is an existing tag for ${tag}`);
      const existing = await fetchTag(tag);

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
      await buildAndPushDockerImage({
        // TODO: improve the type guarding to remove the need to do this
        env: {
          DOCKER_PASSWORD: env.DOCKER_PASSWORD,
          DOCKER_USERNAME: env.DOCKER_PASSWORD,
        },
        checkBehaviour: 'check-tree',
        tag,
        checkTagSha: tagSha
      });

      // Run CI Checks
      await runCICommands();

      const mergebackBranch = `mergeback/${branch.substr(4)}/${version}`;
      info(`Creating and pushing mergeback Branch: ${mergebackBranch}`);
      await git.branch({ fs, dir, ref: mergebackBranch });
      await exec(`git push ${remote.remote} ${mergebackBranch}`, { cwd: dir });

      info(`Opening Mergeback Pull Request`);
      const base = mode === 'env-production' ? config.stagingEnvironmentBranch : 'develop';
      await github.openPullRequest({
        base,
        head: mergebackBranch,
        title: `Update ${base} with changes from ${branch}`,
        labels: config.mergebackLabels || []
      });

      info(`Pull Request Opened, workflow complete`);

    } else if (mode === 'env-development') {
      await runCICommands();
      await buildAndPushDockerImage({
        // TODO: improve the type guarding to remove the need to do this
        env: {
          DOCKER_PASSWORD: env.DOCKER_PASSWORD,
          DOCKER_USERNAME: env.DOCKER_PASSWORD,
        },
        checkBehaviour: 'overwrite',
        tag: branch
      });
    } else if (mode === 'develop') {
      await runCICommands();
    } else if (mode === 'hotfix') {
      const pullRequest = await getUniquePullRequest();

      // Check that the base branch is either env/<stage|staging> or env/prod

      const baseBranch = pullRequest.base.ref;
      if (baseBranch !== 'env/prod' && baseBranch !== config.stagingEnvironmentBranch) {
        await failWithPRComment({
          error: `Pull request from hotfix/ branch made against ${pullRequest.base.ref}`,
          pullRequest,
          comment: (
            `Pull requests from \`hotfix/<name>\` branches can only target ` +
            `\`env/prod\` and \`${config.stagingEnvironmentBranch}\`:\n\n` +
            `* If this is supposed to be a hotfix, please re-target this pull request.\n` +
            `* If this is not supposed to be a hotfix, ` +
            `please use a branch name that does not begin with \`hotfix/\``
          )
        });
      }

      // Check that the version in package.json has been updated between the base branch and HEAD.
      await exec(`git fetch ${remote.remote} ${baseBranch}`, { cwd: dir });
      const base = await readRefShaAndVersion(`refs/remotes/${remote.remote}/${baseBranch}`);
      if (base.version === version) {
        const file = versionFilePath(config.repoType);
        await failWithPRComment({
          error: `Hotfix has same version as base (target) branch`,
          pullRequest,
          comment: (
            `This hotfix pull request does not update the version in \`${file}\`\n\n` +
            `You must update this branch with a version bump before a docker ` +
            `image will be built for you.`
          )
        });
      }

      // Check that there is no existing tag for the current version in package.json
      // (this will be created automatically when merged).
      const tag = `v${version}`;
      info(`Checking if there is an existing tag for ${tag}`);
      const existing = await fetchTag(tag);
      if (existing) {
        const file = versionFilePath(config.repoType);
        await failWithPRComment({
          error: `Tag already exists for version ${tag}, aborting.`,
          pullRequest,
          comment: (
            `There is already a tag for version ${tag},` +
            `so we can't create another release with the same version.\n\n` +
            `Please update the version in \`${file}\`\n\n to something ` +
            `that has not yet had peen deployed to \`env/prod\` ` +
            `or \`${config.stagingEnvironmentBranch}\`.`
          )
        });
      }

      // Check that the current HEAD of the base branch is an ancestor of the
      // HEAD of the hotfix branch (i.e., that the hotfix is a fast-forward,
      // and includes any other changes that may have been made to the target
      // environment).

      if (!await git.isDescendent({
        fs,
        dir,
        ancestor: base.sha,
        oid: head.oid
      })) {
        await failWithPRComment({
          error: `Hotfix is not a descendant of target (base) branch`,
          pullRequest,
          comment: (
            `\`${branch}\` (${head.oid}) is not a descendant of ` +
            `\`${baseBranch}\` (${base.sha}), which means there are new ` +
            `commits in \`${baseBranch}\` that aren't included in \`${branch}\`.\n\n` +
            `Please rebase \`${branch}\` on-top of \`${baseBranch}\` ` +
            `(or merge \`${baseBranch}\` into \`${branch}\`).`
          )
        });
      }

    }

  }
}
