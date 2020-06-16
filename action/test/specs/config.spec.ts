import {tmpdir} from 'os';
import * as path from 'path';
import {promises as fs} from 'fs'

import * as config from '../../src/config';

const TEST_CONFIG_PATH = path.join(tmpdir(), 'config.spec.ts.json');

describe('config', () => {

  it('Require CONFIG_FILE variable', async () => {

    await config.getConfig({})
      .then(() => Promise.reject(new Error('Expected error to be thrown')))
      .catch((err: Error) => {
        expect(err.message).toEqual('Environment Variable CONFIG_FILE is required');
      });

  });

  it('Ensure path is valid file', async () => {

    await config.getConfig({
      CONFIG_FILE: 'foo'
    })
      .then(() => Promise.reject(new Error('Expected error to be thrown')))
      .catch((err: Error) => {
        expect(err.message).toEqual(
          'Could not find configuration file "foo" specified in CONFIG_FILE'
        );
      });

  });

  it('Ensure config is valid JSON', async () => {

    await fs.writeFile(TEST_CONFIG_PATH, '{');

    await config.getConfig({
      CONFIG_FILE: TEST_CONFIG_PATH
    }).then(() => Promise.reject(new Error('Expected error to be thrown')))
      .catch((err: Error) => {
        expect(err.message.replace(TEST_CONFIG_PATH, '<file>')).toEqual(
          'The configuration file at "<file>" is not valid JSON: ' +
          'Unexpected end of JSON input'
        );
      });

  });

  it('Invalid Config', async () => {

    await fs.writeFile(TEST_CONFIG_PATH, JSON.stringify({
      stagingEnvironmentBranch: 'branch-a'
    }));

    await config.getConfig({
      CONFIG_FILE: TEST_CONFIG_PATH
    }).then(() => Promise.reject(new Error('Expected error to be thrown')))
      .catch((err: Error) => {
        expect(err.message.startsWith('Invalid Configuration:')).toBeTruthy();
      });

  });

  it('Valid', async () => {

    await fs.writeFile(TEST_CONFIG_PATH, JSON.stringify({
      stagingEnvironmentBranch: 'env/stage'
    }));

    await config.getConfig({
      CONFIG_FILE: TEST_CONFIG_PATH
    })

  });

});
