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
  runBuild: (tag: string, meta: DockerImageMetadata) => Promise<void>;
  /**
   * Push the image with the given tag to the configured destination
   */
  pushImage: (tag: string) => Promise<void>;
}

export const REAL_DOCKER: DockerInit = config => ({
  checkExistingImage: () => Promise.reject(new Error('not yet implemented')),
  runBuild: () => Promise.reject(new Error('not yet implemented')),
  pushImage: () => Promise.reject(new Error('not yet implemented')),
});
