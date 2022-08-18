import * as child_process from 'child_process';
import fs from 'fs';
import git from 'isomorphic-git';
import { promisify } from 'util';
import type { PushEvent } from '@octokit/webhooks-types';

import { execAndPipeOutput } from './util/child_process';

import { Env, Config, getConfig } from './config';
import { DockerInit, REAL_DOCKER } from './docker';
import { GitHubInit, REAL_GITHUB, PullRequest } from './github';

const exec = promisify(child_process.exec);

const GITHUB_ACTIONS_USER_ID = 41898282;
const GITHUB_ACTIONS_USER_LOGIN = 'github-actions';
const DEPENDABOT_USER_ID = 49699333;
const DEPENDABOT_USER_LOGIN = 'dependabot';
const UNOCHA_HPC_USER_ID = 90184116;

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
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
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
  name: 'push';
  payload: PushEvent;
};

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
};

export class NoPullRequestError extends Error {}

export const runAction = async ({
  env,
  dir = process.cwd(),
  logger = console,
  dockerInit = REAL_DOCKER,
  gitHubInit = REAL_GITHUB,
}: Params) => {
  const info = (message: string) => logger.log(`##[info] ${message}`);

  const config = await getConfig(env);

  // Get event information

  if (!env.GITHUB_EVENT_NAME) {
    throw new Error('Expected GITHUB_EVENT_NAME');
  }
  if (!env.GITHUB_EVENT_PATH) {
    throw new Error('Expected GITHUB_EVENT_PATH');
  }
  if (!env.GITHUB_REPOSITORY) {
    throw new Error('Expected GITHUB_REPOSITORY');
  }

  // Get docker credentials
  if (!config.docker.skipLogin) {
    if (!env.DOCKER_USERNAME) {
      throw new Error('Expected DOCKER_USERNAME');
    }
    if (!env.DOCKER_PASSWORD) {
      throw new Error('Expected DOCKER_PASSWORD');
    }
  }

  // Get GitHub credentials
  if (!env.GITHUB_TOKEN) {
    throw new Error('Expected GITHUB_TOKEN');
  }

  let event: GitHubEvent;

  if (env.GITHUB_EVENT_NAME === 'push') {
    event = {
      name: 'push',
      payload: JSON.parse(
        (await fs.promises.readFile(env.GITHUB_EVENT_PATH)).toString()
      ),
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

    type PackageJson = {
      name: string;
      version: string;
    };

    const readRefShaAndVersion = async (
      ref?: string
    ): Promise<{
      sha: string;
      version: string;
    }> => {
      const sha = await git.resolveRef({ fs, dir, ref: ref || 'HEAD' });
      if (config.repoType === 'node') {
        const pkg = await git
          .readBlob({
            fs,
            dir,
            oid: sha,
            filepath: versionFilePath(config.repoType),
          })
          .catch(() => {
            throw new Error(
              `Unable to read version from package.json: File not found in commit ${sha}`
            );
          });
        let json: PackageJson;
        try {
          json = JSON.parse(new TextDecoder('utf-8').decode(pkg.blob));
        } catch (err) {
          let errMsg = 'Unable to read version from package.json: Invalid JSON';
          if (err instanceof Error) {
            errMsg += `: ${err.message}`;
          }
          throw new Error(errMsg);
        }
        const version = json.version;
        if (typeof version !== 'string') {
          throw new Error(`Invalid version in package.json`);
        }
        return { sha, version };
      } else {
        throw new Error('Unsupported repo type: ' + config.repoType);
      }
    };

    // Get remote information

    const remotes = await git
      .listRemotes({
        fs,
        dir,
      })
      .catch(() => {
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
    const currentBranch = await git.currentBranch({ fs, dir });
    if (!currentBranch) {
      throw new Error('no branch is currently checked out');
    } else if (currentBranch !== branch) {
      throw new Error('incorrect branch currently checked-out');
    }
    const head = await git.readCommit({ fs, dir, oid: headShaAndVersion.sha });

    /**
     * Return true if this is a pull request created by the GitHub Actions user,
     * or dependabot, and so attempting to review the PR with the GitHub Actions
     * token will fail, and commenting is required instead.
     */
    const commentMode = (pr: PullRequest): 'review' | 'comment' | 'none' =>
      pr.user?.id === UNOCHA_HPC_USER_ID ||
      pr.user?.id === GITHUB_ACTIONS_USER_ID ||
      (pr.user?.login.startsWith(GITHUB_ACTIONS_USER_LOGIN) &&
        pr.user?.type.toLowerCase() === 'bot')
        ? 'comment'
        : pr.user?.id === DEPENDABOT_USER_ID ||
          (pr.user?.login.startsWith(DEPENDABOT_USER_LOGIN) &&
            pr.user?.type.toLowerCase() === 'bot')
        ? 'none'
        : 'review';

    type BuildAndPushDockerImageCheckTagCondition =
      | {
          mode: 'match';
          gitTag: string;
          sha: string;
        }
      | {
          mode: 'non-existant';
          gitTag: string;
          /**
           * Run this callback when the constraint is not met.
           *
           * This allows for a custom error message to be posted to GitHub
           */
          onError?: () => Promise<void>;
        };

    const buildAndPushDockerImage = async (opts: {
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
      checkBehaviour: null | {
        /**
         * If checkStrict is true,
         * check whether an image with the same tag already exists,
         * and if it does,
         * check to see that it was built with the same git tree sha.
         * If it was not, throw an error, otherwise continue to checking
         * any other tags, or building the image.
         */
        checkStrict: boolean;
        /**
         * For each tag in this list,
         * attempt to pull down the docker image, and check the tree hash
         * that it was built with.
         * If it was built using the same tree hash,
         * then simply push this existing image using the new tag.
         */
        alsoCheck: string[];
      };
      /**
       * Tag to use when building and pushing the docker image
       */
      tag: string;
      /**
       * If defined,
       * check the state of the given tag in the upstream repo before pushing
       * the image, and throw an error if the constraint isn't met.
       *
       * This is a safeguard against pushing different images with the same tag
       */
      checkTag?:
        | BuildAndPushDockerImageCheckTagCondition
        | {
            mode: 'conditional';
            /**
             * What condition needs to be met before pushing a retagged image
             */
            retagged: BuildAndPushDockerImageCheckTagCondition;
            /**
             * What condition needs to be met before pushing a build image
             */
            built: BuildAndPushDockerImageCheckTagCondition;
          };
    }) => {
      const { tag, checkBehaviour } = opts;
      info(`Logging in to docker`);
      const docker = dockerInit(config.docker);
      if (!config.docker.skipLogin) {
        if (!env.DOCKER_USERNAME || !env.DOCKER_PASSWORD) {
          throw new Error('Unexpected error!');
        }
        await docker.login({
          user: env.DOCKER_USERNAME,
          pass: env.DOCKER_PASSWORD,
        });
      }

      /**
       * Set this to the image tag for any image we find that
       * that was built with the same git tree.
       */
      let existingMatchingImage: string | null = null;
      if (checkBehaviour) {
        info(`Checking for existing docker image with tag ${tag}`);
        const isImagePulled = await docker.pullImage(tag, logger);
        const image = isImagePulled && (await docker.getMetadata(tag));

        if (image) {
          // An image already exists, make sure it was built using the same files
          info(
            `Image already exists, checking it was built with same git tree`
          );
          if (image.treeSha !== head.commit.tree) {
            if (checkBehaviour.checkStrict) {
              throw new Error(`Image was built with different tree, aborting`);
            } else {
              info(
                `This image was built with a different tree, we can't use it`
              );
            }
          } else {
            info(`Image was built with same tree, no need to run build again`);
            return;
          }
        } else {
          info(`Image with tag ${tag} does not yet exist`);
        }
        for (const tag of checkBehaviour.alsoCheck) {
          info(`Checking for existing docker image with tag ${tag}`);
          const isImagePulled = await docker.pullImage(tag, logger);
          const image = isImagePulled && (await docker.getMetadata(tag));
          if (image) {
            info(
              `Image already exists, checking it was built with same git tree`
            );
            if (image.treeSha !== head.commit.tree) {
              info(
                `This image was built with a different tree, we can't use it`
              );
            } else {
              info(
                `Image was built with same tree, no need to run build again`
              );
              existingMatchingImage = tag;
              continue;
            }
          } else {
            info(`No image exists with this tag`);
          }
        }
        if (!existingMatchingImage) {
          info(`Building new image`);
        }
      } else if (!checkBehaviour) {
        info(
          `Skipping check for existing image with tag ${tag}, building new image`
        );
      }

      if (existingMatchingImage) {
        // Retag this existing image with the new tag we want
        info(`Retagging ${existingMatchingImage} as ${tag}`);
        await docker.retagImage(existingMatchingImage, tag);
      } else {
        await docker.runBuild({
          tag,
          meta: {
            commitSha: head.oid,
            treeSha: head.commit.tree,
          },
          cwd: dir,
          logger,
        });
      }
      const checkTag =
        opts.checkTag?.mode === 'conditional'
          ? existingMatchingImage
            ? opts.checkTag.retagged
            : opts.checkTag.built
          : opts.checkTag;
      if (checkTag?.mode === 'match') {
        const tag = checkTag.gitTag;
        info(`Image built, checking tag ${tag} is unchanged`);
        await git.deleteRef({ fs, dir, ref: `refs/tags/${tag}` });
        await exec(`git fetch ${remote.remote} ${tag}:${tag}`, { cwd: dir });
        const newTagSha = await git.resolveRef({
          fs,
          dir,
          ref: `refs/tags/${tag}`,
        });
        if (newTagSha !== checkTag.sha) {
          throw new Error('Tag has changed, aborting');
        } else {
          info(`Tag is unchanged, okay to continue`);
        }
      } else if (checkTag?.mode === 'non-existant') {
        const tag = checkTag.gitTag;
        info(`Image built, checking tag ${tag} still does not exist`);
        const doesExist = await exec(
          `git fetch ${remote.remote} ${tag}:${tag}`,
          {
            cwd: dir,
          }
        )
          .then(() => true)
          .catch(() => false);
        if (doesExist) {
          if (checkTag.onError) {
            await checkTag.onError();
          } else {
            throw new Error(`Tag ${tag} now exists, aborting`);
          }
        } else {
          info(`Tag has not been created, okay to continue`);
        }
      } else {
        info(`Image built`);
      }
      info(`Pushing image to docker repository`);
      await docker.pushImage(tag);
      info(`Image Pushed`);
    };

    const runCICommands = async () => {
      info(`Running CI Checks`);

      for (const command of config.ci || []) {
        info(`Running: ${command}`);
        await execAndPipeOutput({ command, cwd: dir, logger });
      }

      info(`CI Checks Complete`);
    };

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
    };

    const failWithPRComment = async (opts: {
      pullRequest: PullRequest;
      comment: string;
      error: string;
    }) => {
      const { pullRequest, comment, error } = opts;
      const cMode = commentMode(pullRequest);
      if (cMode === 'comment') {
        await github.commentOnPullRequest({
          pullRequestNumber: pullRequest.number,
          body: comment,
        });
      } else if (cMode === 'review') {
        await github.reviewPullRequest({
          pullRequestNumber: pullRequest.number,
          body: comment,
          state: 'reject',
        });
      }
      throw new Error(error);
    };

    /**
     * Try and fetch a specific tag from the remote,
     * and return true if it exists and was successful
     */
    const fetchTag = (tag: string) =>
      exec(`git fetch ${remote.remote} ${tag}:${tag}`, { cwd: dir })
        .then(() => true)
        .catch((err) => {
          if (err.stderr.indexOf(`fatal: couldn't find remote ref`) > -1) {
            return false;
          } else {
            throw err;
          }
        });

    const checkTagNotUsed = async (tag: string, pullRequest: PullRequest) => {
      info(`Checking if there is an existing tag for ${tag}`);
      const doesExist = await fetchTag(tag);
      if (doesExist) {
        const file = versionFilePath(config.repoType);
        await failWithPRComment({
          error: `Tag already exists for version ${tag}, aborting.`,
          pullRequest,
          comment:
            `There is already a tag for version ${tag},` +
            `so we can't create another release with the same version.\n\n` +
            `Please update the version in \`${file}\`\n\n to something ` +
            `that has not yet had peen deployed to \`env/prod\` ` +
            `or \`${config.stagingEnvironmentBranch}\`.`,
        });
      }
    };

    const checkDescendant = async (params: {
      baseBranch: string;
      base: { sha: string };
      pullRequest: PullRequest;
      errorMessage: string;
    }) => {
      const { base, baseBranch, pullRequest, errorMessage } = params;

      // Before checking descendant, fetch the most recent 1000 commits of the
      // hotfix branch (as actions/checkout will have fetched with a depth of 1)
      await exec(`git fetch --depth 1000 ${remote.remote} ${branch}`, {
        cwd: dir,
      });
      if (
        !(await git.isDescendent({
          fs,
          dir,
          ancestor: base.sha,
          oid: head.oid,
        }))
      ) {
        await failWithPRComment({
          error: `${branch} is not a descendant of target (base) branch ${baseBranch}`,
          pullRequest,
          comment: errorMessage,
        });
      }
    };

    const buildAndPushDockerImageForReleaseOrHotfix = (params: {
      /**
       * The docker tag to use
       */
      dockerTag: string;
      /**
       * The git tag to ensure doesn't exist before pushing the image
       */
      gitTag: string;
      pullRequest: PullRequest;
    }) => {
      const { dockerTag, gitTag, pullRequest } = params;

      return buildAndPushDockerImage({
        checkBehaviour: null,
        tag: dockerTag,
        checkTag: {
          mode: 'non-existant',
          gitTag,
          onError: () =>
            failWithPRComment({
              error: `Tag ${gitTag} has been created, aborting`,
              pullRequest,
              comment:
                `During the build of the docker image, the tag ${dockerTag} ` +
                `was created, and so the workflow has been aborted, ` +
                `and the docker image has not been pushed.\n\n` +
                `Please chose a new version and update the pull request.`,
            }),
        },
      });
    };

    const commentOnPullRequestWithDockerInfo = (params: {
      pullRequest: PullRequest;
      tag: string;
    }) => {
      const { pullRequest, tag } = params;
      // Post about successful
      const body =
        `Docker image has been successfully built and pushed as: ` +
        `\`${config.docker.repository}:${tag}\`\n\n` +
        `Please deploy this image to a development environment, and test ` +
        `it is working as expected before merging this pull request.`;
      const cMode = commentMode(pullRequest);
      if (cMode === 'comment') {
        return github.commentOnPullRequest({
          pullRequestNumber: pullRequest.number,
          body,
        });
      } else if (cMode === 'review') {
        return github.reviewPullRequest({
          pullRequestNumber: pullRequest.number,
          body,
          state: 'approve',
        });
      }
    };

    const createDeploymentIfRequired = async (params: {
      dockerTag: string;
      ref: string;
    }) => {
      if (config.deployments) {
        for (const environment of config.deployments.environments) {
          if (environment.branch === branch) {
            info(`Creating ${environment.environment} deployment`);
            await github.createDeployment({
              auto_merge: false,
              required_contexts: [],
              environment: environment.environment,
              payload: {
                docker_tag: params.dockerTag,
              },
              production_environment: mode === 'env-production',
              transient_environment: false,
              ref: params.ref,
              task: 'deploy',
            });
          }
        }
      }
    };

    // Handle the push as appropriate for the given branch

    if (mode === 'env-production' || mode === 'env-staging') {
      const tag = `v${version}`;
      const preTag = `${tag}-pre`;
      info(`Checking if there is an existing tag for ${tag}`);
      const doesExist = await fetchTag(tag);

      /**
       * The commit sha for the tag after it's been created or checked
       */
      let tagSha: string | null = null;
      if (doesExist) {
        // Check that the tree hash of the existing tag matches
        // (i.e. the content hasn't changed without changing the version)
        info(
          `The tag ${tag} already exists, checking that tree hasn't changed`
        );
        tagSha = await git.resolveRef({ fs, dir, ref: `refs/tags/${tag}` });
        const tagHead = await git.readCommit({ fs, dir, oid: tagSha });
        if (tagHead.commit.tree !== head.commit.tree) {
          throw new Error(`New push to ${branch} without bumping version`);
        } else if (tagHead.oid === head.oid) {
          info(`The tag is for the current commit, okay to continue`);
        } else {
          info(`The current tree matches the existing tag, okay to continue`);
        }
      } else if (mode === 'env-production') {
        // Create and push the tag if production
        info(`Creating and pushing new tag ${tag}`);
        await git.tag({ fs, dir, ref: tag });
        tagSha = await git.resolveRef({ fs, dir, ref: `refs/tags/${tag}` });
        await exec(`git push ${remote.remote} ${tag}`, { cwd: dir });
      }

      // Check whether there is an existing docker image, and build if needed

      let deploymentSha: string;
      let deploymentDockerTag: string;
      if (mode === 'env-production') {
        if (!tagSha) {
          throw new Error('Missing Tag Sha');
        }
        deploymentSha = tagSha;
        deploymentDockerTag = tag;
        await buildAndPushDockerImage({
          checkBehaviour: {
            checkStrict: true,
            alsoCheck: [preTag],
          },
          tag,
          checkTag: {
            mode: 'match',
            gitTag: tag,
            sha: tagSha,
          },
        });
      } else {
        await buildAndPushDockerImage({
          checkBehaviour: {
            checkStrict: false,
            alsoCheck: [tag],
          },
          tag: preTag,
          checkTag: {
            mode: 'conditional',
            built: {
              mode: 'non-existant',
              gitTag: tag,
            },
            // If an image is retagged, and we know about an existing git tag
            // then ensure that the git tag is still the same,
            // otherwise require that it doesn't exist
            retagged: tagSha
              ? {
                  mode: 'match',
                  gitTag: tag,
                  sha: tagSha,
                }
              : {
                  mode: 'non-existant',
                  gitTag: tag,
                },
          },
        });
        deploymentSha = head.oid;
        deploymentDockerTag = preTag;
      }

      await createDeploymentIfRequired({
        dockerTag: deploymentDockerTag,
        ref: deploymentSha,
      });

      const mergebackBranch = `mergeback/${branch.substr(4)}/${version}`;
      info(`Creating and pushing mergeback Branch: ${mergebackBranch}`);
      await git.branch({ fs, dir, ref: mergebackBranch });
      await exec(`git push ${remote.remote} ${mergebackBranch}`, { cwd: dir });

      info(`Opening Mergeback Pull Request`);
      const base =
        mode === 'env-production' ? config.stagingEnvironmentBranch : 'develop';
      await github.openPullRequest({
        base,
        head: mergebackBranch,
        title: `Update ${base} with changes from ${branch}`,
        labels: config.mergebackLabels || [],
      });

      info(`Pull Request Opened, workflow complete`);
    } else if (mode === 'env-development') {
      const tag = branch.replace(/\//g, '-');
      await buildAndPushDockerImage({
        checkBehaviour: null,
        tag,
      });
      await createDeploymentIfRequired({
        dockerTag: tag,
        ref: head.oid,
      });
    } else if (mode === 'hotfix') {
      const pullRequest = await getUniquePullRequest();

      // Check that the base branch is either env/<stage|staging> or env/prod

      const baseBranch = pullRequest.base.ref;
      if (
        baseBranch !== 'env/prod' &&
        baseBranch !== config.stagingEnvironmentBranch
      ) {
        await failWithPRComment({
          error: `Pull request from hotfix/ branch made against ${baseBranch}`,
          pullRequest,
          comment:
            `Pull requests from \`hotfix/<name>\` branches can only target ` +
            `\`env/prod\` and \`${config.stagingEnvironmentBranch}\`:\n\n` +
            `* If this is supposed to be a hotfix, please re-target this pull request.\n` +
            `* If this is not supposed to be a hotfix, ` +
            `please use a branch name that does not begin with \`hotfix/\``,
        });
      }

      // Check that there is no existing tag for the current version in package.json
      // (this will be created automatically when merged).
      const tag = `v${version}`;
      await checkTagNotUsed(tag, pullRequest);

      // Check that the current HEAD of the base branch is an ancestor of the
      // HEAD of the hotfix branch (i.e., that the hotfix is a fast-forward,
      // and includes any other changes that may have been made to the target
      // environment).

      await exec(`git fetch ${remote.remote} ${baseBranch}`, { cwd: dir });
      const base = await readRefShaAndVersion(
        `refs/remotes/${remote.remote}/${baseBranch}`
      );
      await checkDescendant({
        base,
        baseBranch,
        pullRequest,
        errorMessage:
          `\`${branch}\` (${head.oid}) is not a descendant of ` +
          `\`${baseBranch}\` (${base.sha}), which means there are new ` +
          `commits in \`${baseBranch}\` that aren't included in \`${branch}\`.\n\n` +
          `Please rebase \`${branch}\` on-top of \`${baseBranch}\` ` +
          `(or merge \`${baseBranch}\` into \`${branch}\`).`,
      });

      const dockerTag = `${tag}-pre`;

      await buildAndPushDockerImageForReleaseOrHotfix({
        dockerTag,
        gitTag: tag,
        pullRequest,
      });

      await runCICommands();

      await commentOnPullRequestWithDockerInfo({ pullRequest, tag: dockerTag });
    } else if (mode === 'release') {
      const pullRequest = await getUniquePullRequest();

      // Check that the base branch is env/<stage|staging>

      const baseBranch = pullRequest.base.ref;
      if (baseBranch !== config.stagingEnvironmentBranch) {
        await failWithPRComment({
          error: `Pull request from release/ branch made against ${baseBranch}`,
          pullRequest,
          comment:
            `Pull requests from \`release/<name>\` branches can only target ` +
            `\`${config.stagingEnvironmentBranch}\`:\n\n` +
            `* If this is supposed to be a release, please re-target this pull request.\n` +
            `* If this is not supposed to be a release, ` +
            `please use a branch name that does not begin with \`release/\``,
        });
      }

      // Check that there is no existing tag for the current version in package.json.
      const tag = `v${version}`;
      await checkTagNotUsed(tag, pullRequest);

      // Check that the current HEAD of the base branch is an ancestor of the
      // HEAD of the release branch
      await exec(`git fetch ${remote.remote} ${baseBranch}`, { cwd: dir });
      const base = await readRefShaAndVersion(
        `refs/remotes/${remote.remote}/${baseBranch}`
      );
      await checkDescendant({
        base,
        baseBranch,
        pullRequest,
        errorMessage:
          `\`${branch}\` (${head.oid}) is not a descendant of ` +
          `\`${baseBranch}\` (${base.sha}), which means there are new ` +
          `commits in \`${baseBranch}\` that aren't included in \`${branch}\`.\n\n` +
          `Please merge \`${baseBranch}\` into \`${branch}\`.`,
      });

      const dockerTag = `${tag}-pre`;

      await buildAndPushDockerImageForReleaseOrHotfix({
        dockerTag,
        gitTag: tag,
        pullRequest,
      });

      await runCICommands();

      await commentOnPullRequestWithDockerInfo({ pullRequest, tag: dockerTag });
    } else if (mode === 'other') {
      const pullRequest = await getUniquePullRequest();

      // Check that the base branch is NOT env/<stage|staging> or env/prod

      const baseBranch = pullRequest.base.ref;
      if (
        baseBranch === config.stagingEnvironmentBranch &&
        !branch.startsWith('mergeback/')
      ) {
        await failWithPRComment({
          error: `Pull request from ${branch} made against ${baseBranch}`,
          pullRequest,
          comment:
            `Pull requests that modify \`${config.stagingEnvironmentBranch}\` must be either:\n\n` +
            `* a release, merging \`release/<version>\` into \`${config.stagingEnvironmentBranch}\`, or\n` +
            `* a hotfix, merging \`hotfix/<name>\` into \`${config.stagingEnvironmentBranch}\`\n` +
            `* an automated mergeback pull request, merging \`mergeback/<name>\` into \`${config.stagingEnvironmentBranch}\`\n\n` +
            `For more information, please read our [Releases + Deployment process](https://github.com/UN-OCHA/hpc-actions#releases--deployment)`,
        });
      } else if (baseBranch === 'env/prod') {
        await failWithPRComment({
          error: `Pull request from ${branch} made against ${baseBranch}`,
          pullRequest,
          comment:
            `Pull requests that modify \`env/prod\` must be either:\n\n` +
            `* an update, merging \`${config.stagingEnvironmentBranch}\` into \`env/prod\`, or\n` +
            `* a hotfix, merging \`hotfix/<name>\` into \`env/prod\`\n\n` +
            `For more information, please read our [Releases + Deployment process](https://github.com/UN-OCHA/hpc-actions#releases--deployment)`,
        });
      }

      await runCICommands();

      const cMode = commentMode(pullRequest);
      if (cMode === 'comment') {
        return github.commentOnPullRequest({
          pullRequestNumber: pullRequest.number,
          body: `Checks have passed and this pull request is ready for manual review`,
        });
      } else if (cMode === 'review') {
        return github.reviewPullRequest({
          pullRequestNumber: pullRequest.number,
          body: `Checks have passed and this pull request is ready for manual review`,
          state: 'approve',
        });
      }
    }
  }
};
