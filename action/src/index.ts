import { runAction } from './action';

runAction({
  env: process.env
}).catch(err => {
  console.error(err);
  process.exit(1);
});
