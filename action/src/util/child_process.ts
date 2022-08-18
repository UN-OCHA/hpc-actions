import * as child_process from 'child_process';
import { promisify } from 'util';

import { Logger } from './interfaces';

/**
 * Like child_process.exec,
 * but pipe all stdout and stderr to the given logger.
 *
 * Optionally, send data to the stdin of the child process
 */
export const execAndPipeOutput = (opts: {
  command: string;
  cwd: string;
  logger: Logger;
  /**
   * If set, pipe the given data to the child process
   */
  data?: string;
}) => {
  const { command, cwd, logger } = opts;
  const p = child_process.execFile('sh', ['-c', command], { cwd });
  const buffer = {
    stderr: '',
    stdout: '',
  };
  for (const stream of ['stdout', 'stderr'] as const) {
    const handle = (data: string) => {
      buffer[stream] += data;
      let nextBreak: number;
      while ((nextBreak = buffer[stream].indexOf('\n')) > -1) {
        const ready = buffer[stream].substr(0, nextBreak);
        buffer[stream] = buffer[stream].substr(nextBreak + 1);
        logger[stream === 'stdout' ? 'log' : 'error'](ready);
      }
    };
    p[stream]?.on('data', handle);
  }
  if (opts.data) {
    if (!p.stdin) {
      throw new Error('Unexpected Error');
    }
    p.stdin.setDefaultEncoding('utf-8');
    p.stdin.write(opts.data);
    p.stdin.end();
  }
  return new Promise((resolve, reject) =>
    p.on('exit', (code) => {
      // Print any remaining data
      for (const stream of ['stdout', 'stderr'] as const) {
        if (buffer[stream] !== '') {
          logger[stream === 'stdout' ? 'log' : 'error'](buffer[stream]);
        }
      }
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Command "${command}" exited with exit code ${code}`));
      }
    })
  );
};

export const exec = promisify(child_process.exec);
