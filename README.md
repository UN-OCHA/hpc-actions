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

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**

- [Workflow](#workflow)
  - [Branches](#branches)
  - [Development Work](#development-work)
  - [Releases + Deployment](#releases--deployment)
  - [Hotfixes](#hotfixes)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

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

### Hotfixes

Hotfixes should be used sparingly,
as it short-circuits the usual release process,
and may result in less thoroughly tested code.
They are also only relevant for the staging and production environments.

To create and deploy a hotfix:

* Create a new branch called `hotfix/<name>`,
  based on either the `env/<stage|staging>` or `env/prod` branch
  (whichever environment is experiencing the problem
  that needs to be addressed).
* If possible, create unit-tests that detect the problem and fail.
* Write a fix for the issue, which should cause the unit-tests to pass.
* Update the version in package.json
  (e.g. with a -hotfix-<name> suffix or minor version bump).
* Push the changes to GitHub
* Open a **DRAFT** Pull Request to merge `hotfix/<name>` into either
  `env/<stage|staging>` or `env/prod` (as appropriate).
  * This will trigger a build of the docker image using GitHub Actions
    following the CI tests passing.
* Once the image is built:
  * Pick a development environment `env/<name>`
    and confirm that it's not in use by anyone else.
  * Restore data from production/staging (as appropriate) to that environment.
  * Deploy image to that environment.
  * Add a comment to the PR detailing the deployment.
  * Test that the hotfix is working as expected
* Once fully tested, reviewed and ready, mark the Pull Request as ready,
  and merge it.
* If possible, wait for CI checks on `env/<stage|staging>` or `env/prod` to
  complete once more.
* Deploy to the appropriate environment using the appropriate method.
* Test that the fix is working in this environment.

## License

Copyright 2020 United Nations Office for the Coordination of Humanitarian Affairs

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

<http://www.apache.org/licenses/LICENSE-2.0>

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.