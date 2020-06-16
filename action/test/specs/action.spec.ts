import * as fs from 'fs';
import * as child_process from 'child_process';
import git from 'isomorphic-git';
import * as path from 'path';
import { promisify } from 'util';

import * as util from '../util';

import { Config } from '../../src/config';
import * as action from '../../src/action';

const exec = promisify(child_process.exec);

const CONFIG_FILE = util.tmpConfigFilePath(__filename);

const DEFAULT_CONFIG: Config = {
  stagingEnvironmentBranch: 'env/stage',
  repoType: 'node',
};

describe('action', () => {

  describe('runAction', () => {

    it('Not in GitHub Repo', async () => {
      const dir = await util.createTmpDir();
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await action.runAction({
        env: {
          CONFIG_FILE
        },
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
      await action.runAction({
        env: {
          CONFIG_FILE
        },
        dir
      }).then(() => Promise.reject(new Error('Expected error to be thrown')))
        .catch((err: Error) => {
          expect(err.message).toEqual('Exactly 1 remote expected in repository');
        });
    });

    it('Missing package.json', async () => {
      const repo1 = await util.createTmpDir();
      const repo2 = await util.createTmpDir();
      await git.init({ fs, dir: repo1 });
      await exec(`git clone ${repo1} ${repo2}`);
      // Clone repo using command (non-http remotes not supported using isomorphic-git)
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await action.runAction({
        env: {
          CONFIG_FILE
        },
        dir: repo2
      }).then(() => Promise.reject(new Error('Expected error to be thrown')))
        .catch((err: Error) => {
          expect(err.message.startsWith(
            'Unable to read version from package.json: ENOENT'
          )).toBeTruthy();
        });
    });

    it('Invalid package.json', async () => {
      const repo1 = await util.createTmpDir();
      const repo2 = await util.createTmpDir();
      await git.init({ fs, dir: repo1 });
      await exec(`git clone ${repo1} ${repo2}`);
      // Clone repo using command (non-http remotes not supported using isomorphic-git)
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(path.join(repo2, 'package.json'), '{');
      await action.runAction({
        env: {
          CONFIG_FILE
        },
        dir: repo2
      }).then(() => Promise.reject(new Error('Expected error to be thrown')))
        .catch((err: Error) => {
          expect(err.message.startsWith(
            'Unable to read version from package.json: Invalid JSON'
          )).toBeTruthy();
        });
    });

    it('Invalid package.json version', async () => {
      const repo1 = await util.createTmpDir();
      const repo2 = await util.createTmpDir();
      await git.init({ fs, dir: repo1 });
      await exec(`git clone ${repo1} ${repo2}`);
      // Clone repo using command (non-http remotes not supported using isomorphic-git)
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG));
      await fs.promises.writeFile(path.join(repo2, 'package.json'), JSON.stringify({
        version: 1.2
      }));
      await action.runAction({
        env: {
          CONFIG_FILE
        },
        dir: repo2
      }).then(() => Promise.reject(new Error('Expected error to be thrown')))
        .catch((err: Error) => {
          expect(err.message).toEqual('Invalid version in package.json');
        });
    });
  });

});
