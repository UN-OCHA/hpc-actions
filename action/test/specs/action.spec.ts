import git from 'isomorphic-git';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import * as util from '../util';

import * as action from '../../src/action';
import type { Config, Env } from '../../src/config';
import type {
  DockerController,
  DockerImageMetadata,
  DockerInit,
} from '../../src/docker';
import type { GitHubController, GitHubInit } from '../../src/github';

const exec = promisify(child_process.exec);

const CONFIG_FILE = util.tmpConfigFilePath(__filename);
const EVENT_FILE = util.tmpEventFilePath(__filename);

const DEFAULT_CONFIG: Config = {
  stagingEnvironmentBranch: 'env/staging',
  repoType: 'node',
  developmentEnvironmentBranches: ['env/dev'],
  docker: {
    path: '.',
    args: {
      commitSha: '',
      treeSha: '',
    },
    environmentVariables: {
      commitSha: '',
      treeSha: '',
    },
    repository: '',
  },
  ci: [],
  mergebackLabels: ['some-label'],
};

const DEFAULT_ENV: Env = {
  CONFIG_FILE,
  GITHUB_EVENT_NAME: 'push',
  GITHUB_EVENT_PATH: EVENT_FILE,
  DOCKER_PASSWORD: 'pass',
  DOCKER_USERNAME: 'user',
  GITHUB_TOKEN: 'asdfg',
  GITHUB_REPOSITORY: 'fooo/barr',
};

const DEFAULT_PUSH_ENV = {};

const author = {
  email: 'foo@foo.com',
  name: 'foo',
};

const setAuthor = async (cwd: string) => {
  await exec(`git config user.name "${author.name}"`, { cwd });
  await exec(`git config user.email "${author.email}"`, { cwd });
};

describe('action', () => {
  describe('runAction', () => {
    const testCompleteError = new Error('TEST COMPLETE');

    const testCompleteDockerController: DockerController = {
      login: () => Promise.resolve(),
      pullImage: () => Promise.reject(testCompleteError),
      getMetadata: () => Promise.reject(testCompleteError),
      runBuild: () => Promise.reject(testCompleteError),
      retagImage: () => Promise.reject(testCompleteError),
      pushImage: () => Promise.reject(testCompleteError),
    };

    const testCompleteGitHub: GitHubController = {
      openPullRequest: () => Promise.reject(testCompleteError),
      getOpenPullRequests: () => Promise.reject(testCompleteError),
      reviewPullRequest: () => Promise.reject(testCompleteError),
      commentOnPullRequest: () => Promise.reject(testCompleteError),
      createDeployment: () => Promise.reject(new Error('Not Implemented')),
    };

    const testCompleteDockerInit: DockerInit = () =>
      testCompleteDockerController;
    const testCompleteGitHubInit: GitHubInit = () => testCompleteGitHub;

    it('Not in GitHub Repo', async () => {
      const dir = await util.createTmpDir();
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(EVENT_FILE, JSON.stringify(DEFAULT_PUSH_ENV));
      await action
        .runAction({
          env: DEFAULT_ENV,
          dir,
        })
        .then(() => {
          throw new Error('Expected error to be thrown');
        })
        .catch((error: Error) => {
          expect(error.message).toEqual('Action not run within git repository');
        });
    });

    it('Missing remote', async () => {
      const dir = await util.createTmpDir();
      await git.init({ fs, dir });
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(EVENT_FILE, JSON.stringify(DEFAULT_PUSH_ENV));
      await action
        .runAction({
          env: DEFAULT_ENV,
          dir,
        })
        .then(() => {
          throw new Error('Expected error to be thrown');
        })
        .catch((error: Error) => {
          expect(error.message).toEqual(
            'Exactly 1 remote expected in repository'
          );
        });
    });

    it('Missing package.json', async () => {
      const dir = await util.createTmpDir();
      await git.init({ fs, dir });
      await git.addRemote({ fs, dir, remote: 'origin', url: 'foo' });
      await fs.promises.writeFile(path.join(dir, 'foo'), 'bar');
      await git.add({ fs, dir, filepath: 'foo' });
      await setAuthor(dir);
      await exec('git commit -m package', { cwd: dir });
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(EVENT_FILE, JSON.stringify(DEFAULT_PUSH_ENV));
      await action
        .runAction({
          env: DEFAULT_ENV,
          dir,
        })
        .then(() => {
          throw new Error('Expected error to be thrown');
        })
        .catch((error: Error) => {
          expect(
            error.message.startsWith(
              'Unable to read version from package.json: File not found in commit'
            )
          ).toBeTruthy();
        });
    });

    it('Invalid package.json', async () => {
      const dir = await util.createTmpDir();
      await git.init({ fs, dir });
      await git.addRemote({ fs, dir, remote: 'origin', url: 'foo' });
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(EVENT_FILE, JSON.stringify(DEFAULT_PUSH_ENV));
      await fs.promises.writeFile(path.join(dir, 'package.json'), '{');
      await git.add({ fs, dir, filepath: 'package.json' });
      await setAuthor(dir);
      await exec('git commit -m package', { cwd: dir });
      await action
        .runAction({
          env: DEFAULT_ENV,
          dir,
        })
        .then(() => {
          throw new Error('Expected error to be thrown');
        })
        .catch((error: Error) => {
          expect(
            error.message.startsWith(
              'Unable to read version from package.json: Invalid JSON'
            )
          ).toBeTruthy();
        });
    });

    it('Invalid package.json version', async () => {
      const dir = await util.createTmpDir();
      await git.init({ fs, dir });
      await git.addRemote({ fs, dir, remote: 'origin', url: 'foo' });
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(EVENT_FILE, JSON.stringify(DEFAULT_PUSH_ENV));
      await fs.promises.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          version: 1.2,
        })
      );
      await git.add({ fs, dir, filepath: 'package.json' });
      await setAuthor(dir);
      await exec('git commit -m package', { cwd: dir });
      await action
        .runAction({
          env: DEFAULT_ENV,
          dir,
        })
        .then(() => {
          throw new Error('Expected error to be thrown');
        })
        .catch((error: Error) => {
          expect(error.message).toEqual('Invalid version in package.json');
        });
    });

    it('Skip push events to tags', async () => {
      const dir = await util.createTmpDir();
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(
        EVENT_FILE,
        JSON.stringify({
          ref: 'refs/tags/v0.0.0',
        })
      );
      const logger = util.newLogger();
      await action.runAction({
        env: DEFAULT_ENV,
        dir,
        logger,
      });
      expect(logger.log.mock.calls).toEqual([
        ['##[info] Push is for tag, skipping action'],
      ]);
    });

    describe('push to production or staging', () => {
      for (const env of ['prod', 'staging']) {
        describe(`env/${env}`, () => {
          describe('tagging', () => {
            it('Non-Existant Tag', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(
                path.join(upstream, 'package.json'),
                JSON.stringify({
                  version: '1.2.0',
                })
              );
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec('git commit -m package', { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(
                CONFIG_FILE,
                JSON.stringify(DEFAULT_CONFIG)
              );
              await fs.promises.writeFile(
                EVENT_FILE,
                JSON.stringify({
                  ref: `refs/heads/env/${env}`,
                })
              );
              const logger = util.newLogger();
              await action
                .runAction({
                  env: DEFAULT_ENV,
                  dir,
                  logger,
                  dockerInit: testCompleteDockerInit,
                })
                .then(() => {
                  throw new Error('Expected error to be thrown');
                })
                .catch((error) => expect(error).toBe(testCompleteError));
              expect(logger.log.mock.calls).toMatchSnapshot();
            });

            it('Existing tag (current commit)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(
                path.join(upstream, 'package.json'),
                JSON.stringify({
                  version: '1.2.0',
                })
              );
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec('git commit -m package', { cwd: upstream });
              await git.tag({ fs, dir: upstream, ref: 'v1.2.0' });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(
                CONFIG_FILE,
                JSON.stringify(DEFAULT_CONFIG)
              );
              await fs.promises.writeFile(
                EVENT_FILE,
                JSON.stringify({
                  ref: `refs/heads/env/${env}`,
                })
              );
              const logger = util.newLogger();
              await action
                .runAction({
                  env: DEFAULT_ENV,
                  dir,
                  logger,
                  dockerInit: testCompleteDockerInit,
                })
                .then(() => {
                  throw new Error('Expected error to be thrown');
                })
                .catch((error) => expect(error).toBe(testCompleteError));
              expect(logger.log.mock.calls).toMatchSnapshot();
            });

            it('Existing tag (different commit, matching tree)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(
                path.join(upstream, 'package.json'),
                JSON.stringify({
                  version: '1.2.0',
                })
              );
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec('git commit -m package', { cwd: upstream });
              await git.tag({ fs, dir: upstream, ref: 'v1.2.0' });
              await exec('git commit -m followup --allow-empty', {
                cwd: upstream,
              });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(
                CONFIG_FILE,
                JSON.stringify(DEFAULT_CONFIG)
              );
              await fs.promises.writeFile(
                EVENT_FILE,
                JSON.stringify({
                  ref: `refs/heads/env/${env}`,
                })
              );
              const logger = util.newLogger();
              await action
                .runAction({
                  env: DEFAULT_ENV,
                  dir,
                  logger,
                  dockerInit: testCompleteDockerInit,
                })
                .then(() => {
                  throw new Error('Expected error to be thrown');
                })
                .catch((error) => expect(error).toBe(testCompleteError));
              expect(logger.log.mock.calls).toMatchSnapshot();
            });

            it('Existing tag (changed tree)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(
                path.join(upstream, 'package.json'),
                JSON.stringify({
                  version: '1.2.0',
                })
              );
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec('git commit -m package', { cwd: upstream });
              await git.tag({ fs, dir: upstream, ref: 'v1.2.0' });
              await fs.promises.writeFile(path.join(upstream, 'foo'), 'bar');
              await git.add({ fs, dir: upstream, filepath: 'foo' });
              await exec('git commit -m followup', { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(
                CONFIG_FILE,
                JSON.stringify(DEFAULT_CONFIG)
              );
              await fs.promises.writeFile(
                EVENT_FILE,
                JSON.stringify({
                  ref: `refs/heads/env/${env}`,
                })
              );
              const logger = util.newLogger();
              await action
                .runAction({
                  env: DEFAULT_ENV,
                  dir,
                  logger,
                })
                .then(() => {
                  throw new Error('Expected error to be thrown');
                })
                .catch((error: Error) => {
                  expect(error.message).toEqual(
                    `New push to env/${env} without bumping version`
                  );
                });
              expect(logger.log.mock.calls).toMatchSnapshot();
            });
          });

          describe('docker', () => {
            it('Existing Image (matching sha)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(
                path.join(upstream, 'package.json'),
                JSON.stringify({
                  version: '1.2.0',
                })
              );
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec('git commit -m package', { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(
                CONFIG_FILE,
                JSON.stringify(DEFAULT_CONFIG)
              );
              await fs.promises.writeFile(
                EVENT_FILE,
                JSON.stringify({
                  ref: `refs/heads/env/${env}`,
                })
              );
              const logger = util.newLogger();
              // Prepare docker mock
              const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const head = await git.readCommit({ fs, dir, oid: sha });
              const meta: DockerImageMetadata = {
                commitSha: head.oid,
                treeSha: head.commit.tree,
              };
              const pullImage = jest.fn().mockResolvedValue(true);
              const getMetadata = jest
                .fn()
                .mockImplementation((tag: string) =>
                  tag === 'v1.2.0' ? meta : null
                );
              const retagImage = jest.fn().mockResolvedValue(true);
              await action
                .runAction({
                  env: DEFAULT_ENV,
                  dir,
                  logger,
                  dockerInit: () => ({
                    ...testCompleteDockerController,
                    pullImage,
                    getMetadata,
                    retagImage,
                  }),
                  gitHubInit: testCompleteGitHubInit,
                })
                .then(() => {
                  throw new Error('Expected error to be thrown');
                })
                .catch((error) => expect(error).toBe(testCompleteError));
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect(
                pullImage.mock.calls.map((call) => [call[0]])
              ).toMatchSnapshot();
              expect(getMetadata.mock.calls).toMatchSnapshot();
              expect(retagImage.mock.calls).toMatchSnapshot();
            });

            /**
             * This can happen when a hotfix is made against prod that bumps the
             * version, and a mergeback pull-request is made against env/stage
             * and merged. there will be an image + tag, but no pre-image,
             * so it will need to be retagged and pushed.
             */
            it('Existing Image (matching sha) (existing matching tag)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(
                path.join(upstream, 'package.json'),
                JSON.stringify({
                  version: '1.2.0',
                })
              );
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec('git commit -m package', { cwd: upstream });
              await git.tag({ fs, dir: upstream, ref: 'v1.2.0' });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(
                CONFIG_FILE,
                JSON.stringify(DEFAULT_CONFIG)
              );
              await fs.promises.writeFile(
                EVENT_FILE,
                JSON.stringify({
                  ref: `refs/heads/env/${env}`,
                })
              );
              const logger = util.newLogger();
              // Prepare docker mock
              const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const head = await git.readCommit({ fs, dir, oid: sha });
              const meta: DockerImageMetadata = {
                commitSha: head.oid,
                treeSha: head.commit.tree,
              };
              const pullImage = jest.fn().mockResolvedValue(true);
              const getMetadata = jest
                .fn()
                .mockImplementation((tag: string) =>
                  tag === 'v1.2.0' ? meta : null
                );
              const retagImage = jest.fn().mockResolvedValue(true);
              await action
                .runAction({
                  env: DEFAULT_ENV,
                  dir,
                  logger,
                  dockerInit: () => ({
                    ...testCompleteDockerController,
                    pullImage,
                    getMetadata,
                    retagImage,
                  }),
                  gitHubInit: testCompleteGitHubInit,
                })
                .then(() => {
                  throw new Error('Expected error to be thrown');
                })
                .catch((error) => expect(error).toBe(testCompleteError));
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect(
                pullImage.mock.calls.map((call) => [call[0]])
              ).toMatchSnapshot();
              expect(getMetadata.mock.calls).toMatchSnapshot();
              expect(retagImage.mock.calls).toMatchSnapshot();
            });

            it('Existing Image (different sha)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(
                path.join(upstream, 'package.json'),
                JSON.stringify({
                  version: '1.2.0',
                })
              );
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec('git commit -m package', { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(
                CONFIG_FILE,
                JSON.stringify(DEFAULT_CONFIG)
              );
              await fs.promises.writeFile(
                EVENT_FILE,
                JSON.stringify({
                  ref: `refs/heads/env/${env}`,
                })
              );
              const logger = util.newLogger();
              // Prepare docker mock
              const meta: DockerImageMetadata = {
                commitSha: 'foo',
                treeSha: 'bar',
              };
              const pullImage = jest.fn().mockResolvedValue(true);
              const getMetadata = jest
                .fn()
                .mockImplementation((tag: string) =>
                  tag === 'v1.2.0' ? meta : null
                );
              await action
                .runAction({
                  env: DEFAULT_ENV,
                  dir,
                  logger,
                  dockerInit: () => ({
                    ...testCompleteDockerController,
                    pullImage,
                    getMetadata,
                  }),
                })
                .then(() => {
                  throw new Error('Expected error to be thrown');
                })
                .catch((error: Error) => {
                  if (env === 'prod') {
                    expect(error.message).toEqual(
                      'Image was built with different tree, aborting'
                    );
                  } else {
                    expect(error).toBe(testCompleteError);
                  }
                });
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect(
                pullImage.mock.calls.map((call) => [call[0]])
              ).toMatchSnapshot();
              expect(getMetadata.mock.calls).toMatchSnapshot();
            });

            it('Existing Pre-Release Image (matching sha)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(
                path.join(upstream, 'package.json'),
                JSON.stringify({
                  version: '1.2.0',
                })
              );
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec('git commit -m package', { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(
                CONFIG_FILE,
                JSON.stringify(DEFAULT_CONFIG)
              );
              await fs.promises.writeFile(
                EVENT_FILE,
                JSON.stringify({
                  ref: `refs/heads/env/${env}`,
                })
              );
              const logger = util.newLogger();
              // Prepare docker mock
              const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const head = await git.readCommit({ fs, dir, oid: sha });
              const meta: DockerImageMetadata = {
                commitSha: head.oid,
                treeSha: head.commit.tree,
              };
              const pullImage = jest.fn().mockResolvedValue(true);
              const getMetadata = jest
                .fn()
                .mockImplementation((tag: string) =>
                  tag === 'v1.2.0-pre' ? meta : null
                );
              await action
                .runAction({
                  env: DEFAULT_ENV,
                  dir,
                  logger,
                  dockerInit: () => ({
                    ...testCompleteDockerController,
                    pullImage,
                    getMetadata,
                  }),
                  gitHubInit: testCompleteGitHubInit,
                })
                .then(() => {
                  throw new Error('Expected error to be thrown');
                })
                .catch((error) => expect(error).toBe(testCompleteError));
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect(
                pullImage.mock.calls.map((call) => [call[0]])
              ).toMatchSnapshot();
              expect(getMetadata.mock.calls).toMatchSnapshot();
            });

            it('Existing Pre-Release Image (different sha)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(
                path.join(upstream, 'package.json'),
                JSON.stringify({
                  version: '1.2.0',
                })
              );
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec('git commit -m package', { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(
                CONFIG_FILE,
                JSON.stringify(DEFAULT_CONFIG)
              );
              await fs.promises.writeFile(
                EVENT_FILE,
                JSON.stringify({
                  ref: `refs/heads/env/${env}`,
                })
              );
              const logger = util.newLogger();
              // Prepare docker mock
              const meta: DockerImageMetadata = {
                commitSha: 'foo',
                treeSha: 'bar',
              };
              const pullImage = jest.fn().mockResolvedValue(true);
              const getMetadata = jest
                .fn()
                .mockImplementation((tag: string) =>
                  tag === 'v1.2.0-pre' ? meta : null
                );
              await action
                .runAction({
                  env: DEFAULT_ENV,
                  dir,
                  logger,
                  dockerInit: () => ({
                    ...testCompleteDockerController,
                    pullImage,
                    getMetadata,
                  }),
                  gitHubInit: testCompleteGitHubInit,
                })
                .then(() => {
                  throw new Error('Expected error to be thrown');
                })
                .catch((error) => expect(error).toBe(testCompleteError));
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect(
                pullImage.mock.calls.map((call) => [call[0]])
              ).toMatchSnapshot();
              expect(getMetadata.mock.calls).toMatchSnapshot();
            });

            it('Non-Existant Image', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(
                path.join(upstream, 'package.json'),
                JSON.stringify({
                  version: '1.2.0',
                })
              );
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec('git commit -m package', { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(
                CONFIG_FILE,
                JSON.stringify(DEFAULT_CONFIG)
              );
              await fs.promises.writeFile(
                EVENT_FILE,
                JSON.stringify({
                  ref: `refs/heads/env/${env}`,
                })
              );
              const logger = util.newLogger();
              // Prepare docker mock
              const pullImage = jest.fn().mockResolvedValue(null);
              const getMetadata = jest.fn().mockResolvedValue(null);
              const runBuild = jest.fn().mockResolvedValue(null);
              const retagImage = jest.fn().mockResolvedValue(null);
              const pushImage = jest.fn().mockResolvedValue(null);
              await action
                .runAction({
                  env: DEFAULT_ENV,
                  dir,
                  logger,
                  dockerInit: () => ({
                    login: () => Promise.resolve(),
                    pullImage,
                    getMetadata,
                    runBuild,
                    retagImage,
                    pushImage,
                  }),
                  gitHubInit: testCompleteGitHubInit,
                })
                .then(() => {
                  throw new Error('Expected error to be thrown');
                })
                .catch((error) => expect(error).toBe(testCompleteError));
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect({
                pullImage: pullImage.mock.calls.map((call) => [call[0]]),
                getMetadata: getMetadata.mock.calls,
                retagImage: retagImage.mock.calls,
                pushImage: pushImage.mock.calls,
              }).toMatchSnapshot();
              const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const head = await git.readCommit({ fs, dir, oid: sha });
              const meta: DockerImageMetadata = {
                commitSha: head.oid,
                treeSha: head.commit.tree,
              };
              expect(runBuild.mock.calls).toEqual([
                [
                  {
                    cwd: dir,
                    logger,
                    tag: env === 'prod' ? 'v1.2.0' : 'v1.2.0-pre',
                    meta,
                  },
                ],
              ]);
            });

            it('Non-Existant Image (tag changed)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(
                path.join(upstream, 'package.json'),
                JSON.stringify({
                  version: '1.2.0',
                })
              );
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec('git commit -m package', { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(
                CONFIG_FILE,
                JSON.stringify(DEFAULT_CONFIG)
              );
              await fs.promises.writeFile(
                EVENT_FILE,
                JSON.stringify({
                  ref: `refs/heads/env/${env}`,
                })
              );
              const logger = util.newLogger();
              // Prepare docker mock
              const pullImage = jest.fn().mockResolvedValue(null);
              const getMetadata = jest.fn().mockResolvedValue(null);
              const runBuild = jest.fn().mockImplementation(async () => {
                // Simulate the tag changing by explicitly changing the tag
                // in upstream branch when the build is run
                await fs.promises.writeFile(path.join(upstream, 'foo'), 'bar');
                await git.add({ fs, dir: upstream, filepath: 'foo' });
                await exec('git commit -m followup', { cwd: upstream });
                await git.tag({
                  fs,
                  dir: upstream,
                  ref: 'v1.2.0',
                  force: true,
                });
              });
              const retagImage = jest.fn().mockResolvedValue(null);
              const pushImage = jest.fn().mockResolvedValue(null);
              await action
                .runAction({
                  env: DEFAULT_ENV,
                  dir,
                  logger,
                  dockerInit: () => ({
                    login: () => Promise.resolve(),
                    pullImage,
                    getMetadata,
                    runBuild,
                    retagImage,
                    pushImage,
                  }),
                })
                .then(() => {
                  throw new Error('Expected error to be thrown');
                })
                .catch((error: Error) => {
                  expect(error.message).toEqual(
                    env === 'prod'
                      ? 'Tag has changed, aborting'
                      : 'Tag v1.2.0 now exists, aborting'
                  );
                });
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect({
                pullImage: pullImage.mock.calls.map((call) => [call[0]]),
                getMetadata: getMetadata.mock.calls,
                retagImage: retagImage.mock.calls,
                pushImage: pushImage.mock.calls,
              }).toMatchSnapshot();
              const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const head = await git.readCommit({ fs, dir, oid: sha });
              const meta: DockerImageMetadata = {
                commitSha: head.oid,
                treeSha: head.commit.tree,
              };
              expect(runBuild.mock.calls).toEqual([
                [
                  {
                    cwd: dir,
                    logger,
                    tag: env === 'prod' ? 'v1.2.0' : 'v1.2.0-pre',
                    meta,
                  },
                ],
              ]);
            });
          });

          describe('deployments + mergeback', () => {
            it('match', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(
                path.join(upstream, 'package.json'),
                JSON.stringify({
                  version: '1.2.0',
                })
              );
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec('git commit -m package', { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              const config: Config = {
                ...DEFAULT_CONFIG,
                deployments: {
                  environments: [
                    {
                      branch: `env/${env}`,
                      environment: env,
                    },
                  ],
                },
              };
              await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config));
              await fs.promises.writeFile(
                EVENT_FILE,
                JSON.stringify({
                  ref: `refs/heads/env/${env}`,
                })
              );
              const logger = util.newLogger();
              // Prepare GitHub mock
              const openPullRequest = jest.fn().mockResolvedValue(null);
              const createDeployment = jest.fn().mockResolvedValue(null);
              await action.runAction({
                env: DEFAULT_ENV,
                dir,
                logger,
                dockerInit: () => ({
                  login: () => Promise.resolve(),
                  pullImage: jest.fn().mockResolvedValue(false),
                  getMetadata: () => Promise.reject(new Error('unexpected')),
                  runBuild: jest.fn().mockResolvedValue(null),
                  retagImage: jest.fn().mockResolvedValue(null),
                  pushImage: jest.fn().mockResolvedValue(null),
                }),
                gitHubInit: () => ({
                  ...testCompleteGitHub,
                  openPullRequest,
                  createDeployment,
                }),
              });
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect(openPullRequest.mock.calls).toMatchSnapshot();
              expect(createDeployment.mock.calls).toEqual([
                [
                  {
                    auto_merge: false,
                    environment: env,
                    payload: {
                      docker_tag: env === 'prod' ? 'v1.2.0' : 'v1.2.0-pre',
                    },
                    production_environment: env === 'prod',
                    // TODO: test this more thoroughly
                    // (including getting from existing image)
                    ref: expect.any(String),
                    required_contexts: [],
                    task: 'deploy',
                    transient_environment: false,
                  },
                ],
              ]);
              // Check expected mergeback branch has been pushed to remote
              const shaA = await git.resolveRef({
                fs,
                dir: upstream,
                ref: `refs/heads/mergeback/${env}/1.2.0`,
              });
              const shaB = await git.resolveRef({
                fs,
                dir: upstream,
                ref: `refs/heads/env/${env}`,
              });
              expect(shaA).toEqual(shaB);
            });

            it('no-match', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(
                path.join(upstream, 'package.json'),
                JSON.stringify({
                  version: '1.2.0',
                })
              );
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec('git commit -m package', { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              const config: Config = {
                ...DEFAULT_CONFIG,
                deployments: {
                  environments: [
                    {
                      branch: 'another-branch',
                      environment: env,
                    },
                  ],
                },
              };
              await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config));
              await fs.promises.writeFile(
                EVENT_FILE,
                JSON.stringify({
                  ref: `refs/heads/env/${env}`,
                })
              );
              const logger = util.newLogger();
              // Prepare GitHub mock
              const openPullRequest = jest.fn().mockResolvedValue(null);
              const createDeployment = jest.fn().mockResolvedValue(null);
              await action.runAction({
                env: DEFAULT_ENV,
                dir,
                logger,
                dockerInit: () => ({
                  login: () => Promise.resolve(),
                  pullImage: jest.fn().mockResolvedValue(false),
                  getMetadata: () => Promise.reject(new Error('unexpected')),
                  runBuild: jest.fn().mockResolvedValue(null),
                  retagImage: jest.fn().mockResolvedValue(null),
                  pushImage: jest.fn().mockResolvedValue(null),
                }),
                gitHubInit: () => ({
                  ...testCompleteGitHub,
                  openPullRequest,
                  createDeployment,
                }),
              });
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect(openPullRequest.mock.calls).toMatchSnapshot();
              expect(createDeployment.mock.calls).toEqual([]);
              // Check expected mergeback branch has been pushed to remote
              const shaA = await git.resolveRef({
                fs,
                dir: upstream,
                ref: `refs/heads/mergeback/${env}/1.2.0`,
              });
              const shaB = await git.resolveRef({
                fs,
                dir: upstream,
                ref: `refs/heads/env/${env}`,
              });
              expect(shaA).toEqual(shaB);
            });
          });

          it('mergeback', async () => {
            const upstream = await util.createTmpDir();
            const dir = await util.createTmpDir();
            // Prepare upstream repository
            await git.init({ fs, dir: upstream });
            await fs.promises.writeFile(
              path.join(upstream, 'package.json'),
              JSON.stringify({
                version: '1.2.0',
              })
            );
            await git.add({ fs, dir: upstream, filepath: 'package.json' });
            await setAuthor(upstream);
            await exec('git commit -m package', { cwd: upstream });
            await git.branch({ fs, dir: upstream, ref: `env/${env}` });
            // Clone into repo we'll run in, and create appropriate branch
            await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
            // Run action
            await fs.promises.writeFile(
              CONFIG_FILE,
              JSON.stringify(DEFAULT_CONFIG)
            );
            await fs.promises.writeFile(
              EVENT_FILE,
              JSON.stringify({
                ref: `refs/heads/env/${env}`,
              })
            );
            const logger = util.newLogger();
            // Prepare GitHub mock
            const openPullRequest = jest.fn().mockResolvedValue(null);
            await action.runAction({
              env: DEFAULT_ENV,
              dir,
              logger,
              dockerInit: () => ({
                login: () => Promise.resolve(),
                pullImage: jest.fn().mockResolvedValue(false),
                getMetadata: () => Promise.reject(new Error('unexpected')),
                runBuild: jest.fn().mockResolvedValue(null),
                retagImage: jest.fn().mockResolvedValue(null),
                pushImage: jest.fn().mockResolvedValue(null),
              }),
              gitHubInit: () => ({
                ...testCompleteGitHub,
                openPullRequest,
              }),
            });
            expect(logger.log.mock.calls).toMatchSnapshot();
            expect(openPullRequest.mock.calls).toMatchSnapshot();
            // Check expected mergeback branch has been pushed to remote
            const shaA = await git.resolveRef({
              fs,
              dir: upstream,
              ref: `refs/heads/mergeback/${env}/1.2.0`,
            });
            const shaB = await git.resolveRef({
              fs,
              dir: upstream,
              ref: `refs/heads/env/${env}`,
            });
            expect(shaA).toEqual(shaB);
          });
        });
      }
    });

    describe('push to env/<dev> branch', () => {
      it('Invalid (unconfigured) branch', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'env/dev2' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch env/dev2 ${upstream} ${dir}`);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/env/dev2',
          })
        );
        const logger = util.newLogger();
        await action
          .runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
          })
          .then(() => {
            throw new Error('Expected error to be thrown');
          })
          .catch((error) =>
            expect(error.message).toEqual(
              'Invalid development branch: env/dev2, must be one of: env/dev'
            )
          );
        expect(logger.log.mock.calls).toMatchSnapshot();
      });

      it('Valid Push and Build', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'env/dev' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch env/dev ${upstream} ${dir}`);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/env/dev',
          })
        );
        const logger = util.newLogger();
        // Prepare docker mock
        const pullImage = jest.fn().mockResolvedValue(null);
        const getMetadata = jest.fn().mockResolvedValue(null);
        const runBuild = jest.fn().mockResolvedValue(null);
        const retagImage = jest.fn().mockResolvedValue(null);
        const pushImage = jest.fn().mockResolvedValue(null);
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: () => ({
            login: () => Promise.resolve(),
            pullImage,
            getMetadata,
            runBuild,
            retagImage,
            pushImage,
          }),
          gitHubInit: testCompleteGitHubInit,
        });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(pullImage.mock.calls).toEqual([]);
        expect(getMetadata.mock.calls).toEqual([]);
        expect(retagImage.mock.calls).toEqual([]);
        expect(pushImage.mock.calls).toEqual([['env-dev']]);
        const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        const head = await git.readCommit({ fs, dir, oid: sha });
        const meta: DockerImageMetadata = {
          commitSha: head.oid,
          treeSha: head.commit.tree,
        };
        expect(runBuild.mock.calls).toEqual([
          [
            {
              cwd: dir,
              logger,
              tag: 'env-dev',
              meta,
            },
          ],
        ]);
      });
    });

    describe('push to hotfix/<name> branch', () => {
      it('No pull request opened', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'hotfix/foo' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [],
        });
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/hotfix/foo',
          })
        );
        const logger = util.newLogger();
        await action
          .runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
            }),
          })
          .then(() => {
            throw new Error('Expected error to be thrown');
          })
          .catch((error) => {
            expect(error.message).toEqual(
              'The branch hotfix/foo has no pull requests open yet, so it is not possible to run this workflow.'
            );
            expect(error).toBeInstanceOf(action.NoPullRequestError);
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
      });

      it('Multiple pull request opened', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'hotfix/foo' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{}, {}],
        });
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/hotfix/foo',
          })
        );
        const logger = util.newLogger();
        await action
          .runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
            }),
          })
          .then(() => {
            throw new Error('Expected error to be thrown');
          })
          .catch((error) => {
            expect(error.message).toEqual(
              'Multiple pull requests for branch hotfix/foo are open, so it is not possible to run this workflow.'
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
      });

      it('Pull request opened against invalid branch', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'hotfix/foo' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [
            {
              number: 321,
              base: { ref: 'develop' },
            },
          ],
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/hotfix/foo',
          })
        );
        const logger = util.newLogger();
        await action
          .runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
              reviewPullRequest,
            }),
          })
          .then(() => {
            throw new Error('Expected error to be thrown');
          })
          .catch((error) => {
            expect(error.message).toEqual(
              'Pull request from hotfix/ branch made against develop'
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
      });

      it('Tag already exists', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'env/prod' });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.1',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'hotfix/foo' });
        await git.tag({ fs, dir: upstream, ref: 'v1.2.1' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [
            {
              number: 321,
              base: { ref: 'env/prod' },
            },
          ],
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/hotfix/foo',
          })
        );
        const logger = util.newLogger();
        await action
          .runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
              reviewPullRequest,
            }),
          })
          .then(() => {
            throw new Error('Expected error to be thrown');
          })
          .catch((error) => {
            expect(error.message).toEqual(
              'Tag already exists for version v1.2.1, aborting.'
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
      });

      it('Target not an ancestor', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'env/prod' });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.1',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'hotfix/foo' });
        await git.checkout({ fs, dir: upstream, ref: 'env/prod' });
        await exec('git commit --allow-empty -m another', { cwd: upstream });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [
            {
              number: 321,
              base: { ref: 'env/prod' },
            },
          ],
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/hotfix/foo',
          })
        );
        const logger = util.newLogger();
        await action
          .runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
              reviewPullRequest,
            }),
          })
          .then(() => {
            throw new Error('Expected error to be thrown');
          })
          .catch((error) => {
            expect(error.message).toEqual(
              'hotfix/foo is not a descendant of target (base) branch env/prod'
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toEqual([
          [
            {
              body: expect.any(String),
              pullRequestNumber: 321,
              state: 'reject',
            },
          ],
        ]);
      });

      it('Tag created during build', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'env/prod' });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.1',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'hotfix/foo' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [
            {
              number: 321,
              base: { ref: 'env/prod' },
            },
          ],
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Prepare docker mock
        const pullImage = jest.fn().mockResolvedValue(null);
        const getMetadata = jest.fn().mockResolvedValue(null);
        const runBuild = jest.fn().mockImplementation(async () => {
          // Simulate the tag changing by explicitly changing the tag
          // in upstream branch when the build is run
          await git.tag({ fs, dir: upstream, ref: 'v1.2.1', force: true });
        });
        const retagImage = jest.fn().mockResolvedValue(null);
        const pushImage = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/hotfix/foo',
          })
        );
        const logger = util.newLogger();
        await action
          .runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: () => ({
              login: () => Promise.resolve(),
              pullImage,
              getMetadata,
              runBuild,
              retagImage,
              pushImage,
            }),
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
              reviewPullRequest,
            }),
          })
          .then(() => {
            throw new Error('Expected error to be thrown');
          })
          .catch((error) => {
            expect(error.message).toEqual(
              'Tag v1.2.1 has been created, aborting'
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
        expect({
          pullImage: pullImage.mock.calls.map((call) => [call[0]]),
          getMetadata: getMetadata.mock.calls,
          retagImage: retagImage.mock.calls,
          pushImage: pushImage.mock.calls,
        }).toMatchSnapshot();
        const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        const head = await git.readCommit({ fs, dir, oid: sha });
        const meta: DockerImageMetadata = {
          commitSha: head.oid,
          treeSha: head.commit.tree,
        };
        expect(runBuild.mock.calls).toEqual([
          [
            {
              cwd: dir,
              logger,
              tag: 'v1.2.1-pre',
              meta,
            },
          ],
        ]);
      });

      it('Successful hotfix', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'env/prod' });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.1',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await exec('git commit --allow-empty -m followup', { cwd: upstream });
        await exec('git commit --allow-empty -m followup', { cwd: upstream });
        await exec('git commit --allow-empty -m followup', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'hotfix/foo' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [
            {
              number: 321,
              base: { ref: 'env/prod' },
            },
          ],
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Prepare docker mock
        const pullImage = jest.fn().mockResolvedValue(null);
        const getMetadata = jest.fn().mockResolvedValue(null);
        const runBuild = jest.fn().mockResolvedValue(null);
        const retagImage = jest.fn().mockResolvedValue(null);
        const pushImage = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/hotfix/foo',
          })
        );
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: () => ({
            login: () => Promise.resolve(),
            pullImage,
            getMetadata,
            runBuild,
            retagImage,
            pushImage,
          }),
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest,
          }),
        });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
        expect({
          pullImage: pullImage.mock.calls.map((call) => [call[0]]),
          getMetadata: getMetadata.mock.calls,
          retagImage: retagImage.mock.calls,
          pushImage: pushImage.mock.calls,
        }).toMatchSnapshot();
        const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        const head = await git.readCommit({ fs, dir, oid: sha });
        const meta: DockerImageMetadata = {
          commitSha: head.oid,
          treeSha: head.commit.tree,
        };
        expect(runBuild.mock.calls).toEqual([
          [
            {
              cwd: dir,
              logger,
              tag: 'v1.2.1-pre',
              meta,
            },
          ],
        ]);
      });

      it('Successful hotfix (self)', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'env/prod' });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.1',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await exec('git commit --allow-empty -m followup', { cwd: upstream });
        await exec('git commit --allow-empty -m followup', { cwd: upstream });
        await exec('git commit --allow-empty -m followup', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'hotfix/foo' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [
            {
              number: 321,
              base: { ref: 'env/prod' },
              user: { id: 41_898_282 },
            },
          ],
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        const commentOnPullRequest = jest.fn().mockResolvedValue(null);
        // Prepare docker mock
        const pullImage = jest.fn().mockResolvedValue(null);
        const getMetadata = jest.fn().mockResolvedValue(null);
        const runBuild = jest.fn().mockResolvedValue(null);
        const retagImage = jest.fn().mockResolvedValue(null);
        const pushImage = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/hotfix/foo',
          })
        );
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: () => ({
            login: () => Promise.resolve(),
            pullImage,
            getMetadata,
            runBuild,
            retagImage,
            pushImage,
          }),
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest,
            commentOnPullRequest,
          }),
        });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toEqual([]);
        expect(commentOnPullRequest.mock.calls).toMatchSnapshot();
        expect({
          pullImage: pullImage.mock.calls.map((call) => [call[0]]),
          getMetadata: getMetadata.mock.calls,
          retagImage: retagImage.mock.calls,
          pushImage: pushImage.mock.calls,
        }).toMatchSnapshot();
        const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        const head = await git.readCommit({ fs, dir, oid: sha });
        const meta: DockerImageMetadata = {
          commitSha: head.oid,
          treeSha: head.commit.tree,
        };
        expect(runBuild.mock.calls).toEqual([
          [
            {
              cwd: dir,
              logger,
              tag: 'v1.2.1-pre',
              meta,
            },
          ],
        ]);
      });
    });

    describe('push to release/<name> branch', () => {
      it('Pull request opened against invalid branch', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'release/foo' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch release/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [
            {
              number: 321,
              base: { ref: 'develop' },
            },
          ],
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/release/foo',
          })
        );
        const logger = util.newLogger();
        await action
          .runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
              reviewPullRequest,
            }),
          })
          .then(() => {
            throw new Error('Expected error to be thrown');
          })
          .catch((error) => {
            expect(error.message).toEqual(
              'Pull request from release/ branch made against develop'
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
      });

      it('Successful release', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'env/staging' });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.1',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await exec('git commit --allow-empty -m followup', { cwd: upstream });
        await exec('git commit --allow-empty -m followup', { cwd: upstream });
        await exec('git commit --allow-empty -m followup', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'release/foo' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch release/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [
            {
              number: 321,
              base: { ref: 'env/staging' },
            },
          ],
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Prepare docker mock
        const pullImage = jest.fn().mockResolvedValue(null);
        const getMetadata = jest.fn().mockResolvedValue(null);
        const runBuild = jest.fn().mockResolvedValue(null);
        const retagImage = jest.fn().mockResolvedValue(null);
        const pushImage = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/release/foo',
          })
        );
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: () => ({
            login: () => Promise.resolve(),
            pullImage,
            getMetadata,
            runBuild,
            retagImage,
            pushImage,
          }),
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest,
          }),
        });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
        expect({
          pullImage: pullImage.mock.calls.map((call) => [call[0]]),
          getMetadata: getMetadata.mock.calls,
          retagImage: retagImage.mock.calls,
          pushImage: pushImage.mock.calls,
        }).toMatchSnapshot();
        const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        const head = await git.readCommit({ fs, dir, oid: sha });
        const meta: DockerImageMetadata = {
          commitSha: head.oid,
          treeSha: head.commit.tree,
        };
        expect(runBuild.mock.calls).toEqual([
          [
            {
              cwd: dir,
              logger,
              tag: 'v1.2.1-pre',
              meta,
            },
          ],
        ]);
      });
    });

    it('push to develop branch', async () => {
      const upstream = await util.createTmpDir();
      const dir = await util.createTmpDir();
      // Prepare upstream repository
      await git.init({ fs, dir: upstream });
      await fs.promises.writeFile(
        path.join(upstream, 'package.json'),
        JSON.stringify({
          version: '1.2.0',
        })
      );
      await git.add({ fs, dir: upstream, filepath: 'package.json' });
      await setAuthor(upstream);
      await exec('git commit -m package', { cwd: upstream });
      await git.branch({ fs, dir: upstream, ref: 'develop' });
      // Clone into repo we'll run in, and create appropriate branch
      await exec(`git clone --branch develop ${upstream} ${dir}`);
      // Run action
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(
        EVENT_FILE,
        JSON.stringify({
          ref: 'refs/heads/develop',
        })
      );
      const logger = util.newLogger();
      await action.runAction({
        env: DEFAULT_ENV,
        dir,
        logger,
      });
      expect(logger.log.mock.calls).toMatchSnapshot();
    });

    describe('push to other branch', () => {
      it('Invalid PR against staging', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'some-feature-branch' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch some-feature-branch ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [
            {
              number: 321,
              base: { ref: 'env/staging' },
            },
          ],
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/some-feature-branch',
          })
        );
        const logger = util.newLogger();
        await action
          .runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
              reviewPullRequest,
            }),
          })
          .then(() => {
            throw new Error('Expected error to be thrown');
          })
          .catch((error) => {
            expect(error.message).toEqual(
              'Pull request from some-feature-branch made against env/staging'
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
      });

      it('Invalid PR against prod', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'some-feature-branch' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch some-feature-branch ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [
            {
              number: 321,
              base: { ref: 'env/prod' },
            },
          ],
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/some-feature-branch',
          })
        );
        const logger = util.newLogger();
        await action
          .runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
              reviewPullRequest,
            }),
          })
          .then(() => {
            throw new Error('Expected error to be thrown');
          })
          .catch((error) => {
            expect(error.message).toEqual(
              'Pull request from some-feature-branch made against env/prod'
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
      });

      it('Invalid PR against prod (self)', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'some-feature-branch' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch some-feature-branch ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [
            {
              number: 321,
              base: { ref: 'env/prod' },
              user: {
                id: 123,
                login: 'github-actions[some thing]',
                type: 'Bot',
              },
            },
          ],
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        const commentOnPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/some-feature-branch',
          })
        );
        const logger = util.newLogger();
        await action
          .runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
              reviewPullRequest,
              commentOnPullRequest,
            }),
          })
          .then(() => {
            throw new Error('Expected error to be thrown');
          })
          .catch((error) => {
            expect(error.message).toEqual(
              'Pull request from some-feature-branch made against env/prod'
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toEqual([]);
        expect(commentOnPullRequest.mock.calls).toMatchSnapshot();
      });

      it('Valid PR', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'some-feature-branch' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch some-feature-branch ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [
            {
              number: 321,
              base: { ref: 'develop' },
            },
          ],
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/some-feature-branch',
          })
        );
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit,
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest,
          }),
        });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
      });

      it('Valid PR (self)', async () => {
        /*
         * When the pull request is opened by the github-actions user, we can't
         * review, and instead need to comment.
         */
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(
          path.join(upstream, 'package.json'),
          JSON.stringify({
            version: '1.2.0',
          })
        );
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec('git commit -m package', { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: 'some-feature-branch' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch some-feature-branch ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [
            {
              number: 321,
              base: { ref: 'develop' },
              user: {
                id: 41_898_282,
              },
            },
          ],
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        const commentOnPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(
          CONFIG_FILE,
          JSON.stringify(DEFAULT_CONFIG)
        );
        await fs.promises.writeFile(
          EVENT_FILE,
          JSON.stringify({
            ref: 'refs/heads/some-feature-branch',
          })
        );
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit,
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest,
            commentOnPullRequest,
          }),
        });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toEqual([]);
        expect(commentOnPullRequest.mock.calls).toMatchSnapshot();
      });

      describe('ci', () => {
        it('Command with interleaved stderr and stdout', async () => {
          const upstream = await util.createTmpDir();
          const dir = await util.createTmpDir();
          // Prepare upstream repository
          await git.init({ fs, dir: upstream });
          await fs.promises.writeFile(
            path.join(upstream, 'package.json'),
            JSON.stringify({
              version: '1.2.0',
            })
          );
          await git.add({ fs, dir: upstream, filepath: 'package.json' });
          await setAuthor(upstream);
          await exec('git commit -m package', { cwd: upstream });
          await git.branch({ fs, dir: upstream, ref: 'some-feature-branch' });
          // Clone into repo we'll run in, and create appropriate branch
          await exec(
            `git clone --branch some-feature-branch ${upstream} ${dir}`
          );
          // Prepare github mock
          const getOpenPullRequests = jest.fn().mockResolvedValue({
            data: [
              {
                number: 321,
                base: { ref: 'develop' },
              },
            ],
          });
          const reviewPullRequest = jest.fn().mockResolvedValue(null);
          // Run action
          const config: Config = {
            ...DEFAULT_CONFIG,
            ci: [
              'echo && echo foo && sleep 0.1s && echo bar 1>&2 && sleep 0.1s && echo baz',
            ],
          };
          await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config));
          await fs.promises.writeFile(
            EVENT_FILE,
            JSON.stringify({
              ref: 'refs/heads/some-feature-branch',
            })
          );
          const logger = util.newInterleavedLogger();
          await action.runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
              reviewPullRequest,
            }),
          });
          expect(logger.fn.mock.calls).toMatchSnapshot();
          expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
          expect(reviewPullRequest.mock.calls).toMatchSnapshot();
        });

        it('Command with nonzero exit code', async () => {
          const upstream = await util.createTmpDir();
          const dir = await util.createTmpDir();
          // Prepare upstream repository
          await git.init({ fs, dir: upstream });
          await fs.promises.writeFile(
            path.join(upstream, 'package.json'),
            JSON.stringify({
              version: '1.2.0',
            })
          );
          await git.add({ fs, dir: upstream, filepath: 'package.json' });
          await setAuthor(upstream);
          await exec('git commit -m package', { cwd: upstream });
          await git.branch({ fs, dir: upstream, ref: 'some-feature-branch' });
          // Clone into repo we'll run in, and create appropriate branch
          await exec(
            `git clone --branch some-feature-branch ${upstream} ${dir}`
          );
          // Prepare github mock
          const getOpenPullRequests = jest.fn().mockResolvedValue({
            data: [
              {
                number: 321,
                base: { ref: 'develop' },
              },
            ],
          });
          const reviewPullRequest = jest.fn().mockResolvedValue(null);
          // Run action
          const config: Config = {
            ...DEFAULT_CONFIG,
            ci: ['exit 123'],
          };
          await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config));
          await fs.promises.writeFile(
            EVENT_FILE,
            JSON.stringify({
              ref: 'refs/heads/some-feature-branch',
            })
          );
          const logger = util.newInterleavedLogger();
          await action
            .runAction({
              env: DEFAULT_ENV,
              dir,
              logger,
              dockerInit: testCompleteDockerInit,
              gitHubInit: () => ({
                ...testCompleteGitHub,
                getOpenPullRequests,
                reviewPullRequest,
              }),
            })
            .then(() => {
              throw new Error('Expected error to be thrown');
            })
            .catch((error: Error) => {
              expect(error.message).toEqual(
                'Command "exit 123" exited with exit code 123'
              );
            });
          expect(logger.fn.mock.calls).toMatchSnapshot();
          expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
          expect(reviewPullRequest.mock.calls).toMatchSnapshot();
        });

        it('Check directory', async () => {
          const upstream = await util.createTmpDir();
          const dir = await util.createTmpDir();
          // Prepare upstream repository
          await git.init({ fs, dir: upstream });
          await fs.promises.writeFile(
            path.join(upstream, 'package.json'),
            JSON.stringify({
              version: '1.2.0',
            })
          );
          await git.add({ fs, dir: upstream, filepath: 'package.json' });
          await setAuthor(upstream);
          await exec('git commit -m package', { cwd: upstream });
          await git.branch({ fs, dir: upstream, ref: 'some-feature-branch' });
          // Clone into repo we'll run in, and create appropriate branch
          await exec(
            `git clone --branch some-feature-branch ${upstream} ${dir}`
          );
          // Prepare github mock
          const getOpenPullRequests = jest.fn().mockResolvedValue({
            data: [
              {
                number: 321,
                base: { ref: 'develop' },
              },
            ],
          });
          const reviewPullRequest = jest.fn().mockResolvedValue(null);
          // Run action
          const config: Config = {
            ...DEFAULT_CONFIG,
            ci: ['cat package.json'],
          };
          await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config));
          await fs.promises.writeFile(
            EVENT_FILE,
            JSON.stringify({
              ref: 'refs/heads/some-feature-branch',
            })
          );
          const logger = util.newInterleavedLogger();
          await action.runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
              reviewPullRequest,
            }),
          });
          expect(logger.fn.mock.calls).toMatchSnapshot();
          expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
          expect(reviewPullRequest.mock.calls).toMatchSnapshot();
        });
      });
    });
  });
});
