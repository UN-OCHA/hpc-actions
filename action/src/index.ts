import { runAction } from './action';
import type { Env } from './config';

runAction({
  env: process.env as unknown as Env,
}).catch((error) => {
  console.log(`##[error] ${error.message}`);
  setTimeout(() => {
    console.error(error);
    process.exit(1);
  }, 100);
});
