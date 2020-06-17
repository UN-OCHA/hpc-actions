import * as fs from 'fs';
import * as child_process from 'child_process';
import git from 'isomorphic-git';
import * as path from 'path';
import { promisify } from 'util';

import * as util from '../util';

import { Config, Env } from '../../src/config';
import * as action from '../../src/action';

const exec = promisify(child_process.exec);

const CONFIG_FILE = util.tmpConfigFilePath(__filename);
const EVENT_FILE = util.tmpEventFilePath(__filename);

const DEFAULT_CONFIG: Config = {
  stagingEnvironmentBranch: 'env/staging',
  repoType: 'node',
  developmentEnvironmentBranches: [],
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

      for (const env of ['prod','staging']) {

        describe(`env/${env}`, () => {
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
            await exec(`git commit -m package`, {
              cwd: upstream
            }).catch(err => {
              console.log('out', err.stdout);
              throw err;
            });
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
            });
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
              logger
            });
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
              logger
            });
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
      }

    });
  });
});
