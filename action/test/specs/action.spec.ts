import * as fs from 'fs';
import * as child_process from 'child_process';
import git from 'isomorphic-git';
import * as path from 'path';
import { promisify } from 'util';

import * as util from '../util';

import { Config, Env } from '../../src/config';
import * as action from '../../src/action';
import { DockerImageMetadata, DockerController, DockerInit } from '../../src/docker';
import { GitHubInit, GitHubController } from '../../src/github';

const exec = promisify(child_process.exec);

const CONFIG_FILE = util.tmpConfigFilePath(__filename);
const EVENT_FILE = util.tmpEventFilePath(__filename);

const DEFAULT_CONFIG: Config = {
  stagingEnvironmentBranch: 'env/staging',
  repoType: 'node',
  developmentEnvironmentBranches: [
    'env/dev'
  ],
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
    repository: ''
  },
  ci: [],
  mergebackLabels: ['some-label']
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
}

const setAuthor = async (cwd: string) => {
  await exec(`git config user.name "${author.name}"`, { cwd });
  await exec(`git config user.email "${author.email}"`, { cwd });
}

describe('action', () => {

  describe('runAction', () => {

    const testCompleteError = new Error('TEST COMPLETE');

    const testCompleteDockerController: DockerController = {
      login: () => Promise.resolve(),
      pullImage: () => Promise.reject(testCompleteError),
      getMetadata: () => Promise.reject(testCompleteError),
      runBuild: () => Promise.reject(testCompleteError),
      pushImage: () => Promise.reject(testCompleteError),
    }

    const testCompleteGitHub: GitHubController = {
      openPullRequest: () => Promise.reject(testCompleteError),
      getOpenPullRequests: () => Promise.reject(testCompleteError),
      reviewPullRequest: () => Promise.reject(testCompleteError),
    }

    const testCompleteDockerInit: DockerInit = () => testCompleteDockerController;
    const testCompleteGitHubInit: GitHubInit = () => testCompleteGitHub;

    it('Not in GitHub Repo', async () => {
      const dir = await util.createTmpDir();
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(EVENT_FILE, JSON.stringify(DEFAULT_PUSH_ENV));
      await action.runAction({
        env: DEFAULT_ENV,
        dir
      }).then(() => Promise.reject(new Error('Expected error to be thrown')))
        .catch((err: Error) => {
          expect(err.message).toEqual('Action not run within git repository');
        });
    });

    it('Missing remote', async () => {
      const dir = await util.createTmpDir();
      await git.init({ fs, dir });
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(EVENT_FILE, JSON.stringify(DEFAULT_PUSH_ENV));
      await action.runAction({
        env: DEFAULT_ENV,
        dir
      }).then(() => Promise.reject(new Error('Expected error to be thrown')))
        .catch((err: Error) => {
          expect(err.message).toEqual('Exactly 1 remote expected in repository');
        });
    });

    it('Missing package.json', async () => {
      const dir = await util.createTmpDir();
      await git.init({ fs, dir });
      await git.addRemote({ fs, dir, remote: 'origin', url: 'foo' })
      await fs.promises.writeFile(path.join(dir, 'foo'), 'bar');
      await git.add({ fs, dir, filepath: 'foo' });
      await setAuthor(dir);
      await exec(`git commit -m package`, { cwd: dir });
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(EVENT_FILE, JSON.stringify(DEFAULT_PUSH_ENV));
      await action.runAction({
        env: DEFAULT_ENV,
        dir
      }).then(() => Promise.reject(new Error('Expected error to be thrown')))
        .catch((err: Error) => {
          expect(err.message.startsWith(
            'Unable to read version from package.json: File not found in commit'
          )).toBeTruthy();
        });
    });

    it('Invalid package.json', async () => {
      const dir = await util.createTmpDir();
      await git.init({ fs, dir });
      await git.addRemote({ fs, dir, remote: 'origin', url: 'foo' })
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(EVENT_FILE, JSON.stringify(DEFAULT_PUSH_ENV));
      await fs.promises.writeFile(path.join(dir, 'package.json'), '{');
      await git.add({ fs, dir, filepath: 'package.json' });
      await setAuthor(dir);
      await exec(`git commit -m package`, { cwd: dir });
      await action.runAction({
        env: DEFAULT_ENV,
        dir
      }).then(() => Promise.reject(new Error('Expected error to be thrown')))
        .catch((err: Error) => {
          expect(err.message.startsWith(
            'Unable to read version from package.json: Invalid JSON'
          )).toBeTruthy();
        });
    });

    it('Invalid package.json version', async () => {
      const dir = await util.createTmpDir();
      await git.init({ fs, dir });
      await git.addRemote({ fs, dir, remote: 'origin', url: 'foo' })
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(EVENT_FILE, JSON.stringify(DEFAULT_PUSH_ENV));
      await fs.promises.writeFile(path.join(dir, 'package.json'), JSON.stringify({
        version: 1.2
      }));
      await git.add({ fs, dir, filepath: 'package.json' });
      await setAuthor(dir);
      await exec(`git commit -m package`, { cwd: dir });
      await action.runAction({
        env: DEFAULT_ENV,
        dir
      }).then(() => Promise.reject(new Error('Expected error to be thrown')))
        .catch((err: Error) => {
          expect(err.message).toEqual('Invalid version in package.json');
        });
    });

    it('Skip push events to tags', async () => {
      const dir = await util.createTmpDir();
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
        ref: 'refs/tags/v0.0.0'
      }));
      const logger = util.newLogger();
      await action.runAction({
        env: DEFAULT_ENV,
        dir,
        logger
      });
      expect(logger.log.mock.calls).toEqual([[
        '##[info] Push is for tag, skipping action'
      ]]);
    });

    describe('push to production or staging', () => {

      for (const env of ['prod','staging']) {

        describe(`env/${env}`, () => {
          describe('tagging', () => {
            it('Non-Existant Tag', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
                version: "1.2.0"
              }));
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec(`git commit -m package`, { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
              await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
                ref: `refs/heads/env/${env}`
              }));
              const logger = util.newLogger();
              await action.runAction({
                env: DEFAULT_ENV,
                dir,
                logger,
                dockerInit: testCompleteDockerInit
              }).then(() => Promise.reject(new Error('Expected error to be thrown')))
                .catch(err => expect(err).toBe(testCompleteError));
              expect(logger.log.mock.calls).toMatchSnapshot();
            });

            it('Existing tag (current commit)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
                version: "1.2.0"
              }));
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec(`git commit -m package`, { cwd: upstream });
              await git.tag({ fs, dir: upstream, ref: `v1.2.0` });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
              await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
                ref: `refs/heads/env/${env}`
              }));
              const logger = util.newLogger();
              await action.runAction({
                env: DEFAULT_ENV,
                dir,
                logger,
                dockerInit: testCompleteDockerInit
              }).then(() => Promise.reject(new Error('Expected error to be thrown')))
                .catch(err => expect(err).toBe(testCompleteError));
              expect(logger.log.mock.calls).toMatchSnapshot();
            });

            it('Existing tag (different commit, matching tree)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
                version: "1.2.0"
              }));
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec(`git commit -m package`, { cwd: upstream });
              await git.tag({ fs, dir: upstream, ref: `v1.2.0` });
              await exec(`git commit -m followup --allow-empty`, { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
              await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
                ref: `refs/heads/env/${env}`
              }));
              const logger = util.newLogger();
              await action.runAction({
                env: DEFAULT_ENV,
                dir,
                logger,
                dockerInit: testCompleteDockerInit
              }).then(() => Promise.reject(new Error('Expected error to be thrown')))
                .catch(err => expect(err).toBe(testCompleteError));
              expect(logger.log.mock.calls).toMatchSnapshot();
            });

            it('Existing tag (changed tree)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
                version: "1.2.0"
              }));
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec(`git commit -m package`, { cwd: upstream });
              await git.tag({ fs, dir: upstream, ref: `v1.2.0` });
              await fs.promises.writeFile(path.join(upstream, 'foo'), 'bar');
              await git.add({ fs, dir: upstream, filepath: 'foo' });
              await exec(`git commit -m followup`, { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
              await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
                ref: `refs/heads/env/${env}`
              }));
              const logger = util.newLogger();
              await action.runAction({
                env: DEFAULT_ENV,
                dir,
                logger
              }).then(() => Promise.reject(new Error('Expected error to be thrown')))
                .catch((err: Error) => {
                  expect(err.message).toEqual(`New push to env/${env} without bumping version`);
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
              await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
                version: "1.2.0"
              }));
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec(`git commit -m package`, { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
              await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
                ref: `refs/heads/env/${env}`
              }));
              const logger = util.newLogger();
              // Prepare docker mock
              const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const head = await git.readCommit({ fs, dir, oid: sha });
              const meta: DockerImageMetadata = {
                commitSha: head.oid,
                treeSha: head.commit.tree,
              };
              const checkExistingImage = jest.fn().mockResolvedValue(meta);
              await action.runAction({
                env: DEFAULT_ENV,
                dir,
                logger,
                dockerInit: () => ({
                  ...testCompleteDockerController,
                  checkExistingImage
                }),
                gitHubInit: testCompleteGitHubInit,
              }).then(() => Promise.reject(new Error('Expected error to be thrown')))
                .catch(err => expect(err).toBe(testCompleteError));
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect(checkExistingImage.mock.calls).toMatchSnapshot();
            });

            it('Existing Image (different sha)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
                version: "1.2.0"
              }));
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec(`git commit -m package`, { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
              await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
                ref: `refs/heads/env/${env}`
              }));
              const logger = util.newLogger();
              // Prepare docker mock
              const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const head = await git.readCommit({ fs, dir, oid: sha });
              const meta: DockerImageMetadata = {
                commitSha: 'foo',
                treeSha: 'bar',
              };
              const pullImage = jest.fn().mockResolvedValue(true);
              const getMetadata = jest.fn().mockResolvedValue(meta);
              await action.runAction({
                env: DEFAULT_ENV,
                dir,
                logger,
                dockerInit: () => ({
                  ...testCompleteDockerController,
                  pullImage,
                  getMetadata
                })
              }).then(() => Promise.reject(new Error('Expected error to be thrown')))
                .catch((err: Error) => {
                  expect(err.message).toEqual(
                    'Image was built with different tree, aborting'
                  );
                });
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect(pullImage.mock.calls.map(call => [call[0]])).toMatchSnapshot();
              expect(getMetadata.mock.calls).toMatchSnapshot();
            });

            it('Non-Existant Image', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
                version: "1.2.0"
              }));
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec(`git commit -m package`, { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
              await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
                ref: `refs/heads/env/${env}`
              }));
              const logger = util.newLogger();
              // Prepare docker mock
              const pullImage = jest.fn().mockResolvedValue(null);
              const getMetadata = jest.fn().mockResolvedValue(null);
              const runBuild = jest.fn().mockResolvedValue(null);
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
                  pushImage,
                }),
                gitHubInit: testCompleteGitHubInit,
              }).then(() => Promise.reject(new Error('Expected error to be thrown')))
                .catch(err => expect(err).toBe(testCompleteError));;
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect({
                pullImage: pullImage.mock.calls.map(call => [call[0]]),
                getMetadata: getMetadata.mock.calls,
                pushImage: pushImage.mock.calls,
              }).toMatchSnapshot();
              const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const head = await git.readCommit({ fs, dir, oid: sha });
              const meta: DockerImageMetadata = {
                commitSha: head.oid,
                treeSha: head.commit.tree,
              };
              expect(runBuild.mock.calls).toEqual([[{
                cwd: dir,
                logger,
                tag: "v1.2.0",
                meta
              }]]);
            });

            it('Non-Existant Image (tag changed)', async () => {
              const upstream = await util.createTmpDir();
              const dir = await util.createTmpDir();
              // Prepare upstream repository
              await git.init({ fs, dir: upstream });
              await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
                version: "1.2.0"
              }));
              await git.add({ fs, dir: upstream, filepath: 'package.json' });
              await setAuthor(upstream);
              await exec(`git commit -m package`, { cwd: upstream });
              await git.branch({ fs, dir: upstream, ref: `env/${env}` });
              // Clone into repo we'll run in, and create appropriate branch
              await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
              // Run action
              await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
              await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
                ref: `refs/heads/env/${env}`
              }));
              const logger = util.newLogger();
              // Prepare docker mock
              const pullImage = jest.fn().mockResolvedValue(null);
              const getMetadata = jest.fn().mockResolvedValue(null);
              const runBuild = jest.fn().mockImplementation(async () => {
                // Simulate the tag changing by explicitly changing the tag
                // in upstream branch when the build is run
                await fs.promises.writeFile(path.join(upstream, 'foo'), 'bar');
                await git.add({ fs, dir: upstream, filepath: 'foo' });
                await exec(`git commit -m followup`, { cwd: upstream });
                await git.tag({ fs, dir: upstream, ref: `v1.2.0`, force: true });
              });
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
                  pushImage,
                })
              }).then(() => Promise.reject(new Error('Expected error to be thrown')))
                .catch((err: Error) => {
                  expect(err.message).toEqual('Tag has changed, aborting');
                });
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect({
                pullImage: pullImage.mock.calls.map(call => [call[0]]),
                getMetadata: getMetadata.mock.calls,
                pushImage: pushImage.mock.calls,
              }).toMatchSnapshot();
              const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const head = await git.readCommit({ fs, dir, oid: sha });
              const meta: DockerImageMetadata = {
                commitSha: head.oid,
                treeSha: head.commit.tree,
              };
              expect(runBuild.mock.calls).toEqual([[{
                cwd: dir,
                logger,
                tag: "v1.2.0",
                meta
              }]]);
            });
          });

          it('mergeback', async () => {
            const upstream = await util.createTmpDir();
            const dir = await util.createTmpDir();
            // Prepare upstream repository
            await git.init({ fs, dir: upstream });
            await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
              version: "1.2.0"
            }));
            await git.add({ fs, dir: upstream, filepath: 'package.json' });
            await setAuthor(upstream);
            await exec(`git commit -m package`, { cwd: upstream });
            await git.branch({ fs, dir: upstream, ref: `env/${env}` });
            // Clone into repo we'll run in, and create appropriate branch
            await exec(`git clone --branch env/${env} ${upstream} ${dir}`);
            // Run action
            await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
            await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
              ref: `refs/heads/env/${env}`
            }));
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
                pushImage: jest.fn().mockResolvedValue(null),
              }),
              gitHubInit: () => ({
                ...testCompleteGitHub,
                openPullRequest
              }),
            });
            expect(logger.log.mock.calls).toMatchSnapshot();
            expect(openPullRequest.mock.calls).toMatchSnapshot();
            // Check expected mergeback branch has been pushed to remote
            const shaA = await git.resolveRef({ fs, dir: upstream, ref: `refs/heads/mergeback/${env}/1.2.0` });
            const shaB = await git.resolveRef({ fs, dir: upstream, ref: `refs/heads/env/${env}` });
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
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `env/dev2` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch env/dev2 ${upstream} ${dir}`);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/env/dev2`
        }));
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit
        }).then(() => Promise.reject(new Error('Expected error to be thrown')))
          .catch(err => expect(err.message).toEqual(
            `Invalid development branch: env/dev2, must be one of: env/dev`
          ));
        expect(logger.log.mock.calls).toMatchSnapshot();
      });

      it('Valid Push and Build', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `env/dev` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch env/dev ${upstream} ${dir}`);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/env/dev`
        }));
        const logger = util.newLogger();
        // Prepare docker mock
        const pullImage = jest.fn().mockResolvedValue(null);
        const getMetadata = jest.fn().mockResolvedValue(null);
        const runBuild = jest.fn().mockResolvedValue(null);
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
            pushImage,
          }),
          gitHubInit: testCompleteGitHubInit,
        });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(pullImage.mock.calls).toEqual([]);
        expect(getMetadata.mock.calls).toEqual([]);
        expect(pushImage.mock.calls).toEqual([[
          'env-dev',
        ]]);
        const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        const head = await git.readCommit({ fs, dir, oid: sha });
        const meta: DockerImageMetadata = {
          commitSha: head.oid,
          treeSha: head.commit.tree,
        };
        expect(runBuild.mock.calls).toEqual([[{
          cwd: dir,
          logger,
          tag: "env-dev",
          meta
        }]]);
      });


    });

    describe('push to hotfix/<name> branch', () => {

      it('No pull request opened', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `hotfix/foo` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: []
        });
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/hotfix/foo`
        }));
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit,
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests
          }),
        }).then(() => Promise.reject(new Error('Expected error to be thrown')))
          .catch(err => {
            expect(err.message).toEqual(
              `The branch hotfix/foo has no pull requests open yet, so it is not possible to run this workflow.`
            );
            expect(err).toBeInstanceOf(action.NoPullRequestError);
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
      });

      it('Multiple pull request opened', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `hotfix/foo` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{}, {}]
        });
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/hotfix/foo`
        }));
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit,
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests
          }),
        }).then(() => Promise.reject(new Error('Expected error to be thrown')))
          .catch(err => {
            expect(err.message).toEqual(
              `Multiple pull requests for branch hotfix/foo are open, so it is not possible to run this workflow.`
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
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `hotfix/foo` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{
            number: 321,
            base: { ref: 'develop' }
          }]
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/hotfix/foo`
        }));
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit,
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest
          }),
        }).then(() => Promise.reject(new Error('Expected error to be thrown')))
          .catch(err => {
            expect(err.message).toEqual(
              `Pull request from hotfix/ branch made against develop`
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
      });

      it('Version not bumped', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `hotfix/foo` });
        await git.branch({ fs, dir: upstream, ref: `env/prod` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{
            number: 321,
            base: { ref: 'env/prod' }
          }]
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/hotfix/foo`
        }));
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit,
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest
          }),
        }).then(() => Promise.reject(new Error('Expected error to be thrown')))
          .catch(err => {
            expect(err.message).toEqual(
              `Hotfix has same version as base (target) branch`
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
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `env/prod` });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.1"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `hotfix/foo` });
        await git.tag({ fs, dir: upstream, ref: 'v1.2.1' });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{
            number: 321,
            base: { ref: 'env/prod' }
          }]
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/hotfix/foo`
        }));
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit,
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest
          }),
        }).then(() => Promise.reject(new Error('Expected error to be thrown')))
          .catch(err => {
            expect(err.message).toEqual(
              `Tag already exists for version v1.2.1, aborting.`
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
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `env/prod` });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.1"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `hotfix/foo` });
        await git.checkout({ fs, dir: upstream, ref: `env/prod` });
        await exec(`git commit --allow-empty -m another`, { cwd: upstream });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{
            number: 321,
            base: { ref: 'env/prod' }
          }]
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/hotfix/foo`
        }));
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit,
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest
          }),
        }).then(() => Promise.reject(new Error('Expected error to be thrown')))
          .catch(err => {
            expect(err.message).toEqual(
              `hotfix/foo is not a descendant of target (base) branch env/prod`
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toEqual([[
          {
            body: expect.any(String),
            pullRequestNumber: 321,
            state: 'reject',
          }
        ]]);
      });

      it('Tag created during build', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `env/prod` });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.1"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `hotfix/foo` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{
            number: 321,
            base: { ref: 'env/prod' }
          }]
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Prepare docker mock
        const pullImage = jest.fn().mockResolvedValue(null);
        const getMetadata = jest.fn().mockResolvedValue(null);
        const runBuild = jest.fn().mockImplementation(async () => {
          // Simulate the tag changing by explicitly changing the tag
          // in upstream branch when the build is run
          await git.tag({ fs, dir: upstream, ref: `v1.2.1`, force: true });
        });
        const pushImage = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/hotfix/foo`
        }));
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
            pushImage,
          }),
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest
          }),
        }).then(() => Promise.reject(new Error('Expected error to be thrown')))
          .catch(err => {
            expect(err.message).toEqual(
              `Tag v1.2.1 has been created, aborting`
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
        expect({
          pullImage: pullImage.mock.calls.map(call => [call[0]]),
          getMetadata: getMetadata.mock.calls,
          pushImage: pushImage.mock.calls,
        }).toMatchSnapshot();
        const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        const head = await git.readCommit({ fs, dir, oid: sha });
        const meta: DockerImageMetadata = {
          commitSha: head.oid,
          treeSha: head.commit.tree,
        };
        expect(runBuild.mock.calls).toEqual([[{
          cwd: dir,
          logger,
          tag: "v1.2.1",
          meta
        }]]);
      });

      it('Successful hotfix', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `env/prod` });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.1"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await exec(`git commit --allow-empty -m followup`, { cwd: upstream });
        await exec(`git commit --allow-empty -m followup`, { cwd: upstream });
        await exec(`git commit --allow-empty -m followup`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `hotfix/foo` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch hotfix/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{
            number: 321,
            base: { ref: 'env/prod' }
          }]
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Prepare docker mock
        const pullImage = jest.fn().mockResolvedValue(null);
        const getMetadata = jest.fn().mockResolvedValue(null);
        const runBuild = jest.fn().mockResolvedValue(null);
        const pushImage = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/hotfix/foo`
        }));
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
            pushImage,
          }),
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest
          }),
        });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
        expect({
          pullImage: pullImage.mock.calls.map(call => [call[0]]),
          getMetadata: getMetadata.mock.calls,
          pushImage: pushImage.mock.calls,
        }).toMatchSnapshot();
        const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        const head = await git.readCommit({ fs, dir, oid: sha });
        const meta: DockerImageMetadata = {
          commitSha: head.oid,
          treeSha: head.commit.tree,
        };
        expect(runBuild.mock.calls).toEqual([[{
          cwd: dir,
          logger,
          tag: "v1.2.1",
          meta
        }]]);
      });

    });

    describe('push to release/<name> branch', () => {

      it('Pull request opened against invalid branch', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `release/foo` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch release/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{
            number: 321,
            base: { ref: 'develop' }
          }]
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/release/foo`
        }));
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit,
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest
          }),
        }).then(() => Promise.reject(new Error('Expected error to be thrown')))
          .catch(err => {
            expect(err.message).toEqual(
              `Pull request from release/ branch made against develop`
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
      });

      it('Version not bumped', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `release/foo` });
        await git.branch({ fs, dir: upstream, ref: `env/staging` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch release/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{
            number: 321,
            base: { ref: 'env/staging' }
          }]
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/release/foo`
        }));
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit,
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest
          }),
        }).then(() => Promise.reject(new Error('Expected error to be thrown')))
          .catch(err => {
            expect(err.message).toEqual(
              `Release has same version as base (target) branch`
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
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `env/staging` });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.1"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await exec(`git commit --allow-empty -m followup`, { cwd: upstream });
        await exec(`git commit --allow-empty -m followup`, { cwd: upstream });
        await exec(`git commit --allow-empty -m followup`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `release/foo` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch release/foo ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{
            number: 321,
            base: { ref: 'env/staging' }
          }]
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Prepare docker mock
        const pullImage = jest.fn().mockResolvedValue(null);
        const getMetadata = jest.fn().mockResolvedValue(null);
        const runBuild = jest.fn().mockResolvedValue(null);
        const pushImage = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/release/foo`
        }));
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
            pushImage,
          }),
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest
          }),
        });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
        expect({
          pullImage: pullImage.mock.calls.map(call => [call[0]]),
          getMetadata: getMetadata.mock.calls,
          pushImage: pushImage.mock.calls,
        }).toMatchSnapshot();
        const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        const head = await git.readCommit({ fs, dir, oid: sha });
        const meta: DockerImageMetadata = {
          commitSha: head.oid,
          treeSha: head.commit.tree,
        };
        expect(runBuild.mock.calls).toEqual([[{
          cwd: dir,
          logger,
          tag: "v1.2.1",
          meta
        }]]);
      });

    });

    it('push to develop branch', async () => {
      const upstream = await util.createTmpDir();
      const dir = await util.createTmpDir();
      // Prepare upstream repository
      await git.init({ fs, dir: upstream });
      await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
        version: "1.2.0"
      }));
      await git.add({ fs, dir: upstream, filepath: 'package.json' });
      await setAuthor(upstream);
      await exec(`git commit -m package`, { cwd: upstream });
      await git.branch({ fs, dir: upstream, ref: `develop` });
      // Clone into repo we'll run in, and create appropriate branch
      await exec(`git clone --branch develop ${upstream} ${dir}`);
      // Run action
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
        ref: `refs/heads/develop`
      }));
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
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `some-feature-branch` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch some-feature-branch ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{
            number: 321,
            base: { ref: 'env/staging' }
          }]
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/some-feature-branch`
        }));
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit,
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest
          }),
        }).then(() => Promise.reject(new Error('Expected error to be thrown')))
          .catch(err => {
            expect(err.message).toEqual(
              `Pull request from some-feature-branch made against env/staging`
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
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `some-feature-branch` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch some-feature-branch ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{
            number: 321,
            base: { ref: 'env/prod' }
          }]
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/some-feature-branch`
        }));
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit,
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest
          }),
        }).then(() => Promise.reject(new Error('Expected error to be thrown')))
          .catch(err => {
            expect(err.message).toEqual(
              `Pull request from some-feature-branch made against env/prod`
            );
          });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
      });

      it('Valid PR', async () => {
        const upstream = await util.createTmpDir();
        const dir = await util.createTmpDir();
        // Prepare upstream repository
        await git.init({ fs, dir: upstream });
        await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
          version: "1.2.0"
        }));
        await git.add({ fs, dir: upstream, filepath: 'package.json' });
        await setAuthor(upstream);
        await exec(`git commit -m package`, { cwd: upstream });
        await git.branch({ fs, dir: upstream, ref: `some-feature-branch` });
        // Clone into repo we'll run in, and create appropriate branch
        await exec(`git clone --branch some-feature-branch ${upstream} ${dir}`);
        // Prepare github mock
        const getOpenPullRequests = jest.fn().mockResolvedValue({
          data: [{
            number: 321,
            base: { ref: 'develop' }
          }]
        });
        const reviewPullRequest = jest.fn().mockResolvedValue(null);
        // Run action
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
        await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
          ref: `refs/heads/some-feature-branch`
        }));
        const logger = util.newLogger();
        await action.runAction({
          env: DEFAULT_ENV,
          dir,
          logger,
          dockerInit: testCompleteDockerInit,
          gitHubInit: () => ({
            ...testCompleteGitHub,
            getOpenPullRequests,
            reviewPullRequest
          }),
        });
        expect(logger.log.mock.calls).toMatchSnapshot();
        expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
        expect(reviewPullRequest.mock.calls).toMatchSnapshot();
      });

      describe('ci', () => {

        it('Command with interleaved stderr and stdout', async () => {
          const upstream = await util.createTmpDir();
          const dir = await util.createTmpDir();
          // Prepare upstream repository
          await git.init({ fs, dir: upstream });
          await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
            version: "1.2.0"
          }));
          await git.add({ fs, dir: upstream, filepath: 'package.json' });
          await setAuthor(upstream);
          await exec(`git commit -m package`, { cwd: upstream });
          await git.branch({ fs, dir: upstream, ref: `some-feature-branch` });
          // Clone into repo we'll run in, and create appropriate branch
          await exec(`git clone --branch some-feature-branch ${upstream} ${dir}`);
          // Prepare github mock
          const getOpenPullRequests = jest.fn().mockResolvedValue({
            data: [{
              number: 321,
              base: { ref: 'develop' }
            }]
          });
          const reviewPullRequest = jest.fn().mockResolvedValue(null);
          // Run action
          const config: Config = {
            ...DEFAULT_CONFIG,
            ci: [
              `echo && echo foo && sleep 0.1s && echo bar 1>&2 && sleep 0.1s && echo baz`
            ]
          };
          await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config));
          await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
            ref: `refs/heads/some-feature-branch`
          }));
          const logger = util.newInterleavedLogger();
          await action.runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
              reviewPullRequest
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
          await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
            version: "1.2.0"
          }));
          await git.add({ fs, dir: upstream, filepath: 'package.json' });
          await setAuthor(upstream);
          await exec(`git commit -m package`, { cwd: upstream });
          await git.branch({ fs, dir: upstream, ref: `some-feature-branch` });
          // Clone into repo we'll run in, and create appropriate branch
          await exec(`git clone --branch some-feature-branch ${upstream} ${dir}`);
          // Prepare github mock
          const getOpenPullRequests = jest.fn().mockResolvedValue({
            data: [{
              number: 321,
              base: { ref: 'develop' }
            }]
          });
          const reviewPullRequest = jest.fn().mockResolvedValue(null);
          // Run action
          const config: Config = {
            ...DEFAULT_CONFIG,
            ci: [
              `exit 123`
            ]
          };
          await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config));
          await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
            ref: `refs/heads/some-feature-branch`
          }));
          const logger = util.newInterleavedLogger();
          await action.runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
              reviewPullRequest
            }),
          }).then(() => Promise.reject(new Error('Expected error to be thrown')))
            .catch((err: Error) => {
              expect(err.message).toEqual('Command "exit 123" exited with exit code 123');
            });;
          expect(logger.fn.mock.calls).toMatchSnapshot();
          expect(getOpenPullRequests.mock.calls).toMatchSnapshot();
          expect(reviewPullRequest.mock.calls).toMatchSnapshot();
        });

        it('Check directory', async () => {
          const upstream = await util.createTmpDir();
          const dir = await util.createTmpDir();
          // Prepare upstream repository
          await git.init({ fs, dir: upstream });
          await fs.promises.writeFile(path.join(upstream, 'package.json'), JSON.stringify({
            version: "1.2.0"
          }));
          await git.add({ fs, dir: upstream, filepath: 'package.json' });
          await setAuthor(upstream);
          await exec(`git commit -m package`, { cwd: upstream });
          await git.branch({ fs, dir: upstream, ref: `some-feature-branch` });
          // Clone into repo we'll run in, and create appropriate branch
          await exec(`git clone --branch some-feature-branch ${upstream} ${dir}`);
          // Prepare github mock
          const getOpenPullRequests = jest.fn().mockResolvedValue({
            data: [{
              number: 321,
              base: { ref: 'develop' }
            }]
          });
          const reviewPullRequest = jest.fn().mockResolvedValue(null);
          // Run action
          const config: Config = {
            ...DEFAULT_CONFIG,
            ci: [
              `cat package.json`
            ]
          };
          await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config));
          await fs.promises.writeFile(EVENT_FILE, JSON.stringify({
            ref: `refs/heads/some-feature-branch`
          }));
          const logger = util.newInterleavedLogger();
          await action.runAction({
            env: DEFAULT_ENV,
            dir,
            logger,
            dockerInit: testCompleteDockerInit,
            gitHubInit: () => ({
              ...testCompleteGitHub,
              getOpenPullRequests,
              reviewPullRequest
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
