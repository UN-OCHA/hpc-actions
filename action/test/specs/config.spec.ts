import { promises as fs } from 'node:fs';

import * as util from '../util';

import * as config from '../../src/config';
const TEST_CONFIG_PATH = util.tmpConfigFilePath(__filename);

describe('config', () => {
  it('Require CONFIG_FILE variable', async () => {
    await config
      .getConfig({})
      .then(() => {
        throw new Error('Expected error to be thrown');
      })
      .catch((error: Error) => {
        expect(error.message).toEqual(
          'Environment Variable CONFIG_FILE is required'
        );
      });
  });

  it('Ensure path is valid file', async () => {
    await config
      .getConfig({
        CONFIG_FILE: 'foo',
      })
      .then(() => {
        throw new Error('Expected error to be thrown');
      })
      .catch((error: Error) => {
        expect(error.message).toEqual(
          'Could not find configuration file "foo" specified in CONFIG_FILE'
        );
      });
  });

  it('Ensure config is valid JSON', async () => {
    await fs.writeFile(TEST_CONFIG_PATH, '{');

    await config
      .getConfig({
        CONFIG_FILE: TEST_CONFIG_PATH,
      })
      .then(() => {
        throw new Error('Expected error to be thrown');
      })
      .catch((error: Error) => {
        expect(error.message.replace(TEST_CONFIG_PATH, '<file>')).toEqual(
          'The configuration file at "<file>" is not valid JSON: ' +
            "Expected property name or '}' in JSON at position 1"
        );
      });
  });

  it('Invalid Config', async () => {
    await fs.writeFile(
      TEST_CONFIG_PATH,
      JSON.stringify({
        stagingEnvironmentBranch: 'branch-a',
      })
    );

    await config
      .getConfig({
        CONFIG_FILE: TEST_CONFIG_PATH,
      })
      .then(() => {
        throw new Error('Expected error to be thrown');
      })
      .catch((error: Error) => {
        expect(error.message.startsWith('Invalid Configuration:')).toBeTruthy();
      });
  });

  it('Unmatched docker registry and path', async () => {
    const c: config.Config = {
      stagingEnvironmentBranch: 'env/stage',
      repoType: 'node',
      developmentEnvironmentBranches: [],
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
        repository: 'user/repo',
        registry: 'docker.pkg.github.com',
      },
      ci: [],
    };

    await fs.writeFile(TEST_CONFIG_PATH, JSON.stringify(c));

    await config
      .getConfig({
        CONFIG_FILE: TEST_CONFIG_PATH,
      })
      .then(() => {
        throw new Error('Expected error to be thrown');
      })
      .catch((error: Error) => {
        expect(error.message).toEqual(
          'Invalid Configuration: Docker repository must start with: docker.pkg.github.com/'
        );
      });
  });

  it('Invalid development environment', async () => {
    const c: config.Config = {
      stagingEnvironmentBranch: 'env/stage',
      repoType: 'node',
      developmentEnvironmentBranches: ['dev'],
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
    };

    await fs.writeFile(TEST_CONFIG_PATH, JSON.stringify(c));

    await config
      .getConfig({
        CONFIG_FILE: TEST_CONFIG_PATH,
      })
      .then(() => {
        throw new Error('Expected error to be thrown');
      })
      .catch((error: Error) => {
        expect(error.message).toEqual(
          'Invalid Configuration: All development environment branches must start with env/'
        );
      });
  });

  it('Valid', async () => {
    const c: config.Config = {
      stagingEnvironmentBranch: 'env/stage',
      repoType: 'node',
      developmentEnvironmentBranches: ['env/dev1', 'env/dev2'],
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
    };

    await fs.writeFile(TEST_CONFIG_PATH, JSON.stringify(c));

    await config.getConfig({
      CONFIG_FILE: TEST_CONFIG_PATH,
    });
  });
});
