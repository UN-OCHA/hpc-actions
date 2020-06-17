import * as fs from 'fs';
import * as child_process from 'child_process';
import git from 'isomorphic-git';
import * as path from 'path';
import { promisify } from 'util';

import * as util from '../util';

import { Config, Env } from '../../src/config';
import * as action from '../../src/action';
import { DockerImageMetadata, DockerController, DockerInit } from '../../src/docker';

const exec = promisify(child_process.exec);

const CONFIG_FILE = util.tmpConfigFilePath(__filename);
const EVENT_FILE = util.tmpEventFilePath(__filename);

const DEFAULT_CONFIG: Config = {
  stagingEnvironmentBranch: 'env/staging',
  repoType: 'node',
  developmentEnvironmentBranches: [],
  docker: {
    path: '.'
  }
};

const DEFAULT_ENV: Env = {
  CONFIG_FILE,
  GITHUB_EVENT_NAME: 'push',
  GITHUB_EVENT_PATH: EVENT_FILE,
};

const DEFAULT_PUSH_ENV = {

};

const newLogger = () => ({
  log: jest.fn()
});

const author = {
  email: 'foo@foo.com',
  name: 'foo',
}

const setAuthor = async (cwd: string) => {
  await exec(`git config --global user.name "${author.name}"`, { cwd });
  await exec(`git config --global user.email "${author.email}"`, { cwd });
}

describe('action', () => {

  describe('runAction', () => {

    jest.setTimeout(10000);

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
      await git.addRemote({fs, dir, remote: 'origin', url: 'foo'})
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(EVENT_FILE, JSON.stringify(DEFAULT_PUSH_ENV));
      await action.runAction({
        env: DEFAULT_ENV,
        dir
      }).then(() => Promise.reject(new Error('Expected error to be thrown')))
        .catch((err: Error) => {
          expect(err.message.startsWith(
            'Unable to read version from package.json: ENOENT'
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
      const logger = newLogger();
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

      const testCompleteError = new Error('TEST COMPLETE');

      const testCompleteDockerController: DockerController = {
        checkExistingImage: () => Promise.reject(testCompleteError),
        runBuild: () => Promise.reject(testCompleteError),
        pushImage: () => Promise.reject(testCompleteError),
      }

      const testCompleteDockerInit: DockerInit = () => testCompleteDockerController;

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
              const logger = newLogger();
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
              const logger = newLogger();
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
              const logger = newLogger();
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
              const logger = newLogger();
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
              const logger = newLogger();
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
                })
              });
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
              const logger = newLogger();
              // Prepare docker mock
              const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const head = await git.readCommit({ fs, dir, oid: sha });
              const meta: DockerImageMetadata = {
                commitSha: 'foo',
                treeSha: 'bar',
              };
              const checkExistingImage = jest.fn().mockResolvedValue(meta);
              await action.runAction({
                env: DEFAULT_ENV,
                dir,
                logger,
                dockerInit: () => ({
                  ...testCompleteDockerController,
                  checkExistingImage
                })
              }).then(() => Promise.reject(new Error('Expected error to be thrown')))
                .catch((err: Error) => {
                  expect(err.message).toEqual(
                    'Image was built with different tree, aborting'
                  );
                });
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect(checkExistingImage.mock.calls).toMatchSnapshot();
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
              const logger = newLogger();
              // Prepare docker mock
              const checkExistingImage = jest.fn().mockResolvedValue(null);
              const runBuild = jest.fn().mockResolvedValue(null);
              const pushImage = jest.fn().mockResolvedValue(null);
              await action.runAction({
                env: DEFAULT_ENV,
                dir,
                logger,
                dockerInit: () => ({
                  checkExistingImage,
                  runBuild,
                  pushImage,
                })
              });
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect({
                checkExistingImage: checkExistingImage.mock.calls,
                pushImage: pushImage.mock.calls,
              }).toMatchSnapshot();
              const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const head = await git.readCommit({ fs, dir, oid: sha });
              const meta: DockerImageMetadata = {
                commitSha: head.oid,
                treeSha: head.commit.tree,
              };
              expect(runBuild.mock.calls).toEqual([["v1.2.0", meta]]);
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
              const logger = newLogger();
              // Prepare docker mock
              const checkExistingImage = jest.fn().mockResolvedValue(null);
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
                  checkExistingImage,
                  runBuild,
                  pushImage,
                })
              }).then(() => Promise.reject(new Error('Expected error to be thrown')))
                .catch((err: Error) => {
                  expect(err.message).toEqual('Tag has changed, aborting');
                });
              expect(logger.log.mock.calls).toMatchSnapshot();
              expect(checkExistingImage.mock.calls).toMatchSnapshot();
              const sha = await git.resolveRef({ fs, dir, ref: 'HEAD' });
              const head = await git.readCommit({ fs, dir, oid: sha });
              const meta: DockerImageMetadata = {
                commitSha: head.oid,
                treeSha: head.commit.tree,
              };
              expect(pushImage.mock.calls).toEqual([]);
              expect(runBuild.mock.calls).toEqual([["v1.2.0", meta]]);
            });
          });
        });
      }

    });
  });
});
