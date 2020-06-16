import * as fs from 'fs';
import * as http from 'isomorphic-git/http/node';
import git from 'isomorphic-git';

import * as util from '../util';

import * as action from '../../src/action';

const CONFIG_FILE = util.tmpConfigFilePath(__filename);

describe('action', () => {

  describe('runAction', () => {

    it('Not in GitHub Repo', async () => {
      const dir = await util.createTmpDir();
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify({
        stagingEnvironmentBranch: 'env/stage'
      }));
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
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify({
        stagingEnvironmentBranch: 'env/stage'
      }));
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
  });

});
