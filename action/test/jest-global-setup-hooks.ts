import {promises as fs} from 'fs';

import * as util from './util';

beforeAll(async () => {
  console.log('Creating Temporary Directory');
  await fs.mkdir(util.rootTmpDir());
});
