import * as t from 'io-ts';
import { PathReporter } from 'io-ts/lib/PathReporter';
import { isLeft } from 'fp-ts/lib/Either';

import { exec, execAndPipeOutput } from './util/child_process';
import { Logger } from './util/interfaces';

import { DockerConfig } from './config';

export type DockerInit = (config: DockerConfig) => DockerController;

export interface DockerImageMetadata {
  commitSha: string;
  treeSha: string;
}

export interface DockerController {
  login: (opts: {
    user: string;
    pass: string;
  }) => Promise<void>;
  /**
   * Get the metadata for a docker image that is tagged locally
   */
  getMetadata: (tag: string) => Promise<DockerImageMetadata>;
  /**
   * Try and pull a docker image with the given tag,
   * return true if successful and false if not
   */
  pullImage: (tag: string, logger: Logger) => Promise<boolean>;
  /**
   * Run the docker build, and tag the image with the given tag
   */
  runBuild: (opts: {
    cwd: string;
    tag: string;
    meta: DockerImageMetadata;
    logger: Logger;
  }) => Promise<void>;
  /**
   * Push the image with the given tag to the configured destination
   */
  pushImage: (tag: string) => Promise<void>;
}

/**
 * Codec to consume environment variables from a docker image
 */
const IMAGE_DETAILS = t.array(t.type({
  Config: t.type({
    Env: t.array(t.string)
  })
}));

export const REAL_DOCKER: DockerInit = config => ({

  login: async ({user, pass}) => {
    // Login to docker
    await execAndPipeOutput({
      command: `docker login ${config.registry || ''} -u ${user}  --password-stdin`,
      cwd: __dirname,
      // Drop all console output (it's mostly warning about storing credentials)
      logger: console,
      data: pass + '\n'
    });
  },

  pullImage: (tag, logger) =>
    execAndPipeOutput({
      command: `docker pull ${config.repository}:${tag}`,
      cwd: __dirname,
      logger
    }).then(() => true).catch(() => false),

  getMetadata: async tag => {
    const res = await exec(`docker inspect ${config.repository}:${tag}`);
    const data = JSON.parse(res.stdout);
    const check = IMAGE_DETAILS.decode(data);
    if (isLeft(check)) {
      throw new Error(
        'Unexpected output from docker inspect: \n* ' +
        PathReporter.report(check).join('\n* ')
      );
    }
    if (check.right.length !== 1) {
      throw new Error('Unexpected output from docker inspect: multiple objects');
    }
    const image = check.right[0];
    // Able to parse output
    let commitSha: string | null = null;
    let treeSha: string | null = null;
    const varConfig = config.environmentVariables;
    for (const envVar of image.Config.Env) {
      if (envVar.startsWith(`${varConfig.commitSha}=`)) {
        commitSha = envVar.substr(varConfig.commitSha.length + 1);
      }
      if (envVar.startsWith(`${varConfig.treeSha}=`)) {
        treeSha = envVar.substr(varConfig.treeSha.length + 1);
      }
    }
    if (!commitSha || !treeSha) {
      throw new Error(
        'Unable to extract treeSha and commitSha from docker image'
      );
    }
    return {
      commitSha,
      treeSha,
    };
  },

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

  pushImage: tag =>
    exec(`docker push ${config.repository}:${tag}`).then(() => {}),

});
