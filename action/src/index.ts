import { runAction } from './action';

runAction({
  env: process.env
}).catch(async err => {
  console.log(`##[error] ${err.message}`);
  setTimeout(
    () => {
      console.error(err);
      process.exit(1);
    },
    100
  );
});
