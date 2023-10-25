import { promises as fs } from 'node:fs';

import * as util from './util';

jest.setTimeout(20_000);

beforeAll(async () => {
  console.log('Creating Temporary Directory');
  await fs.mkdir(util.rootTmpDir());
});
