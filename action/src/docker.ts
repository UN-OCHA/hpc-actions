import { execAndPipeOutput } from './util/child_process';
import { Logger } from './util/interfaces';

import { DockerConfig } from './config';

export type DockerInit = (config: DockerConfig) => DockerController;

export interface DockerImageMetadata {
  commitSha: string;
  treeSha: string;
}

export interface DockerController {
  /**
   * Try and pull a docker image with the given tag,
   * and if successful, return the metadata for the image
   */
  checkExistingImage: (tag: string) => Promise<DockerImageMetadata | null>;
  /**
   * Run the docker build, and tag the image with the given tag
   */
  runBuild: (opts: {
    cwd: string,
    tag: string,
    meta: DockerImageMetadata,
    logger: Logger,
  }) => Promise<void>;
  /**
   * Push the image with the given tag to the configured destination
   */
  pushImage: (tag: string) => Promise<void>;
}

export const REAL_DOCKER: DockerInit = config => ({
  checkExistingImage: () => Promise.reject(new Error('not yet implemented')),
  runBuild: async ({ cwd, tag, meta, logger }) => {
    await execAndPipeOutput({
      command: (
        `docker build ${config.path} ` +
        `--build-arg ${config.args.commitSha}=${meta.commitSha} ` +
        `--build-arg ${config.args.treeSha}=${meta.treeSha} ` +
        `-t ${config.repository}:${tag}`
      ),
      logger,
      cwd
    })
  },
  pushImage: () => Promise.reject(new Error('not yet implemented')),
});
