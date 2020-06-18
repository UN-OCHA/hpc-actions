/**
 * Configuration for this action.
 * 
 * Rather than provide all configuration options via environment variables,
 * we've opted to use json configuration files instead to allow for more
 * extensibility. This configuration file will be used for all options,
 * except for secrets, and the config file pathname.
 */
import * as t from 'io-ts';
import { PathReporter } from 'io-ts/lib/PathReporter';
import { either } from 'fp-ts';
import { promises as fs } from 'fs';

/**
 * The environment variables that are expected
 */

export interface Env {
  /**
   * The path to the configuration json file,
   * that adheres to the specification set out by CONFIG above.
   */
  CONFIG_FILE?: string;
  /**
   * The username to login to the docker registry with
   */
  DOCKER_USERNAME?: string;
  /**
   * The password to login to the docker registry with
   */
  DOCKER_PASSWORD?: string;
  /**
   * Token to use when interacting with the GitHub API
   */
  GITHUB_TOKEN?: string;

  // Implicit environment variables passed by GitHub
  GITHUB_REPOSITORY?: string;
  GITHUB_EVENT_NAME?: string;
  GITHUB_EVENT_PATH?: string;
  GITHUB_ACTOR?: string;
}

// Specify the configuration options using io-ts,
// which provides both type-definitions for the configuration,
// and validation that matches these definitions.

const DOCKER_CONFIG = t.intersection([
  // Required Config
  t.type({
    /**
     * Where in the repository should the build be run from
     */
    path: t.string,
    /**
     * What are the names of the build arguments that the docker image
     * expects to be supplied
     */
    args: t.type({
      /**
       * What is the name of the build argument that expects the commit sha
       */
      commitSha: t.string,
      /**
       * What is the name of the build argument that expects the tree sha
       */
      treeSha: t.string,
    }),
    /**
     * What are the names of the environment variables where important bits of
     * information are stored
     */
    environmentVariables: t.type({
      /**
       * What environment variable is used to store the commit sha
       */
      commitSha: t.string,
      /**
       * What environment variable is used to store the tree sha
       */
      treeSha: t.string,
    }),
    /**
     * What's the name of the repository that we'll be tagging
     */
    repository: t.string,
  }),
  // Optional config
  t.partial({
    /**
     * If provided, use the given registry instead of Docker Hub.
     *
     * When this is set, the docker repository must start with this string
     * followed by a slash.
     */
    registry: t.string,
  })
]);

const CONFIG = t.intersection([
  // Required Config
  t.type({
    /**
     * What is the branch for the staging environment.
     */
    stagingEnvironmentBranch: t.keyof({
      'env/stage': null,
      'env/staging': null,
    }),
    /**
     * What are the branches used to track development environments.
     */
    developmentEnvironmentBranches: t.array(t.string),
    /**
     * What type of repository is this?
     * 
     * This is used to work out how to calculate the current version
     */
    repoType: t.keyof({
      /**
       * Calculate the current version by reading the version from package.json
       */
      'node': null,
    }),
    /**
     * Configuration for the docker image build and publication
     */
    docker: DOCKER_CONFIG,
    /**
     * List of shell commands to run as part of CI
     */
    ci: t.array(t.string),
  }),
  // Optional config
  t.partial({
    /**
     * If provided, add these labels to mergeback pull requests
     */
    mergebackLabels: t.array(t.string),
  })
]);

/**
 * The type of a valid configuration file
 */
export type Config = t.TypeOf<typeof CONFIG>;

/**
 * The type for valid docker configuration
 */
export type DockerConfig = t.TypeOf<typeof DOCKER_CONFIG>;

export const getConfig = async (env: Env): Promise<Config> => {
  if (!env.CONFIG_FILE) {
    throw new Error('Environment Variable CONFIG_FILE is required');
  }
  const data = await fs.readFile(env.CONFIG_FILE)
    .catch(err => {
      if (err.message?.startsWith('ENOENT: no such file or directory')) {
        throw new Error(`Could not find configuration file "${env.CONFIG_FILE}" specified in CONFIG_FILE`);
      } else {
        throw err;
      }
    });
  let json: string;
  try {
    json = JSON.parse(data.toString())
  } catch (err) {
    throw new Error(`The configuration file at "${env.CONFIG_FILE}" is not valid JSON: ${err.message}`);
  }
  const config = CONFIG.decode(json);
  if (either.isLeft(config)) {
    throw new Error('Invalid Configuration: \n* ' + PathReporter.report(config).join('\n* '));
  }
  // Check that development environments all start with `env/`
  for (const env of config.right.developmentEnvironmentBranches) {
    if (!env.startsWith('env/')) {
      throw new Error('Invalid Configuration: All development environment branches must start with env/');
    }
  }
  if (
    config.right.docker.registry &&
    !config.right.docker.repository.startsWith(`${config.right.docker.registry}/`)
  ) {
    throw new Error(
      'Invalid Configuration: Docker repository must start with: ' +
      `${config.right.docker.registry}/`
    );
  }
  return config.right;
};
