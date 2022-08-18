import { runAction } from './action';
import type { Env } from './config';

runAction({
  env: process.env as unknown as Env,
}).catch(async (err) => {
  console.log(`##[error] ${err.message}`);
  setTimeout(() => {
    console.error(err);
    process.exit(1);
  }, 100);
});
