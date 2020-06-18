import {promises as fs} from 'fs';

import * as util from './util';

jest.setTimeout(10000);

beforeAll(async () => {
  console.log('Creating Temporary Directory');
  await fs.mkdir(util.rootTmpDir());
});
