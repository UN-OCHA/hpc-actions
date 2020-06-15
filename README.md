# HPC-Actions & Workflow Repository

This repository contains GitHub Actions and documentation that supports the
development, release & deployment workflows used for HPC repositories at OCHA.

The outlined workflow and actions are designed to:

* Prevent accidental deployment of changes that are not yet ready.
* Have a consistent and predictable naming-convention for branches,
  in particular:
  * Have a clear distinction between environment tracking,
    main development, hotfix and feature branches.
* Allow us to know exactly what is deployed to each environment.
* Avoid pushing tags multiple times with different HEADs
* Ensure that all changes have been given enough review,
  and pass unit-tests and code-quality checks before being deployed.
* Automate many processes that have required manual work,
  and are prone to human-error, including:
  * Creating branches and pull requests to bring upstream branches up-to-date
    with production / staging hotfices.
  * Running unit-tests and other CI checks against the correct commits
  * Creating and pushing release tags

## Workflow

### Branches

For this action to be used successfully, the following branch naming scheme
must be followed:

* `develop` **(default, protected)** -
  main target branch for active development work.
  Dependabot package version updates will be conducted on this branch.
* `env/prod` **(protected)** -
  tracking branch for production environment.
  * Must only receive PRs from `env/stage` or `hotfix/<name>` branches.
* `env/stage` or `env/staging` **(protected)** -
  tracking branch for staging environment.
  * Must only receive PRs from `hotfix/<name>`, `release/<version>` or
    `mergeback/prod/<version>` branches.
* `env/<name>` - tracking branches for other (development) environments.
* `release/<version>` -
  release preparation branches
  * These branches should almost always be based on the `develop` branch.
  * Version bumps and release tags should be done on these branches.
* `hotfix/<name>` -
  branches dedicated to hotfixes
  * PRs from these branches should be based on and target either the production
    or staging branches.
* `mergeback/<env>/<version>` -
  branches automatically created to bring upstream branches up-to-date with
  hotfixes on production / staging.
* `<other branches>` -
  any other branch, e.g. those dedicated to fixing a particular issue or
  introducing a new feature.

### Development Work

* Active development work should be based on `develop`
  and PRs should target `develop`.
* PRs should have status checks (linting, unit-tests, etc...) pass,
  and be deployed and tested on a development environment before merging.
* Anything in the `develop` branch is considered "reviewed",
  and ready for deployment to the staging environment.

### Releases + Deployment

* **Development Environments:**

  * Tags / versions are not necessary for deploying to these environments
  * Choose an environment to test on that isn't being used by anyone else
  * Force push the commit you want to test to respective `env/<name>` branch.
    * This will GitHub Actions to build and push the docker image
  * Once the image is built, deploy to the environment using the appropriate
    method.

* **Staging Environment:**

  Except for hotfixes (see below),
  changes to the staging environment will always come from `develop`.

  * Create a local branch based on `develop` called `release/<version>`,
    picking a new version according to Semantic Versioning.
  * Update the version in `package.json` to match the new branch name.
  * Push this branch to GitHub.
  * Open a pull request that merges `release/<version>` into the staging branch
    (either `env/stage` or `env/staging` as neccesary).
  * Once checks pass, merge the pull request, this will automatically:
    * Create the tag / release on GitHub
    * Trigger a build of the docker image in GitHub Actions
    * Open a "mergeback" Pull Request, to merge the changes back into `develop`.
  * After docker image build is complete,
    deploy to the environment using the appropriate method.

* **Production Environment:**

  Except for hotfixes (see below),
  changes to prod will always come from the HEAD of `env/<stage|staging>`.

  * Open a pull request that merges `env/<stage|staging>` into `env/prod`.
    * If there are conflicts, this is likely because of an unmerged "mergeback"
      pull request.
      First look for such a pull request,
      and ensure that changes from `env/prod` are merged back into
      `env/<stage|staging>`, at which point the conflicts should be solved.
  * Once checks pass, merge the pull request, this will:
    * Create the tag / release on GitHub (if neccesary).
    * Trigger a build of the docker image in GitHub Actions (if neccesary).
    * Open a "mergeback" Pull Request, to merge the changes back into develop.
  * After docker image build is complete,
    deploy to the environment using the appropriate method.

