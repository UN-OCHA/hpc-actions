import { promises as fs } from 'fs';
import * as path from 'path';

import * as util from '../util';

import { REAL_DOCKER } from '../../src/docker';

const DOCKER_FILE = `
FROM alpine:3.7

ARG COMMIT_SHA
ARG TREE_SHA
ENV HPC_ACTIONS_COMMIT_SHA $COMMIT_SHA
ENV HPC_ACTIONS_TREE_SHA $TREE_SHA

`;

describe('docker', () => {
  it('Run build and check meta', async () => {
    const dir = await util.createTmpDir();
    await fs.mkdir(path.join(dir, 'docker'));
    await fs.writeFile(path.join(dir, 'docker', 'Dockerfile'), DOCKER_FILE);

    const docker = REAL_DOCKER({
      path: './docker',
      args: {
        commitSha: 'COMMIT_SHA',
        treeSha: 'TREE_SHA',
      },
      environmentVariables: {
        commitSha: 'HPC_ACTIONS_COMMIT_SHA',
        treeSha: 'HPC_ACTIONS_TREE_SHA',
      },
      repository: 'hpc-actions/unit-test',
    });

    const logger = util.newLogger();

    await docker
      .runBuild({
        cwd: dir,
        tag: 'some-tag',
        meta: {
          commitSha: 'foo',
          treeSha: 'bar',
        },
        logger,
      })
      .catch((err) => {
        const errs: string[] = [
          err.message,
          ...logger.error.mock.calls.map((args) => args.join(' ')),
          ...logger.log.mock.calls.map((args) => args.join(' ')),
        ];
        console.error(errs.join('\n'));
        throw err;
      });

    expect(logger.log.mock.calls.length).toBeGreaterThan(1);
    expect(logger.log.mock.calls[logger.log.mock.calls.length - 1]).toEqual([
      'Successfully tagged hpc-actions/unit-test:some-tag',
    ]);

    expect(await docker.getMetadata('some-tag')).toEqual({
      commitSha: 'foo',
      treeSha: 'bar',
    });
  });
});
