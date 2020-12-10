# HPC-Actions & Workflow Repository

[![codecov](https://codecov.io/gh/UN-OCHA/hpc-actions/branch/develop/graph/badge.svg)](https://codecov.io/gh/UN-OCHA/hpc-actions)

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
- [Automation / Roadmap](#automation--roadmap)
- [Usage](#usage)
  - [Docker Images](#docker-images)
- [License](#license)

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
  * Open a pull request with the work you want to deploy / test (it can be a
    draft pull request if it is not ready yet)
  * Choose an environment to test on, and add the appropriate label to the
    pull request (e.g. `deploy to blue.dev`)
  * Create a merge commit of all the pull requests that should be deployed to
    the development environment (these are all the pull requests with the same
    label as the one you added), for example:

    ```bash
    git checkout -b env/blue.dev # create a new branch called env/blue.dev
    git fetch origin develop:develop # Fetch the latest develop branch
    git reset --hard origin/develop # Make this branch equal to the state of the develop branch
    git fetch origin HPC-123 HPC-321 ... # Fetch all required pull requests
    git merge --no-ff origin/HPC-123 origin/HPC-321 # Create a merge commit with all the pull requests
    ```

    (remember to make the appropriate changes to the above commands so that
    you're using the right environment, and including the required pull requests)
  * Force push this commit to the development environment:

    * ```bash
      git push -f origin env/blue.dev
      ```

    * This will GitHub Actions to build and push the docker image,
      and trigger the deployment automatically

* **Staging Environment:**

  Except for hotfixes (see below),
  changes to the staging environment will always come from `develop`.

  * Create a local branch based on `develop` called `release/<version>`,
    picking a new version according to Semantic Versioning.
  * Update the version in `package.json` to match the new branch name.
  * Push this branch to GitHub.
  * Open a pull request that merges `release/<version>` into the staging branch
    (either `env/stage` or `env/staging` as neccesary).
  * Restart the workflow if neccesary, this will:
    * Build the image with the new tag (with `-pre` appended),
      and push it to DockerHub
    * Run the CI / Unit Tests
    * Post a comment on the pull request when the workflow has finished successfully
  * Once the workflow is complete, merge the pull request, this will automatically:
    * Trigger an automated deployment to the stage environment (if configured)
    * Open a "mergeback" Pull Request, to merge the changes back into `develop`.
      * Please approve and merge this pull request ASAP
    * (note that tags are not created when deploying to staging envs, only prod)

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
    * Create the tag / release on GitHub.
    * Trigger a build of the docker image in GitHub Actions
      (if neccesary, usually not as it should reuse and retag the image on stage).
    * Open a "mergeback" Pull Request, to merge the changes back into develop.
  * After the checks are complete:
    * deploy to the environment using the appropriate method.
    * Approve and merge the mergeback PR

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
  * (this may be automated, depending on configuration)
* Test that the fix is working in this environment.

## Automation / Roadmap

This section describes what automation this repository aims to provide,
and acts as a roadmap.

* Pushes to `env/prod` and `env/<stage|staging>`:
  * Check if there is an existing tag for the current version in `package.json`
    * TODO: *(we'll need to allow for specifying the version in other ways for the
      non-node repos).*
    * If there is a tag existing:
      * Check if the git tree hash for the tag matches the current HEAD,
        and throw an error if not, (i.e. the version needs to be bumped)
    * If there is no existing tag
      * Create it and push it
  * Check if there is an existing docker image tag for the given version.
    * If there is not
      * Run the docker build
      * Fetch the git tag to check the git tree hash has not been changed
        *(this will only happen with rapid concurrent pushes)*
      * Push the image to DockerHub, using the version as the tag
    * If there is
      * get the git tree sha that was used to build the image from the docker metadata
      * check that the git tree-sha of image matches the current tree-sha
        (throw an error if not)
  * Create and push a branch called `mergeback/<env>/<version>`
    based on the current HEAD.
    * (creating a new branch rather than merging the current branch itself allows us to resolve any conflicts if necessary)
  * Open a mergeback PR to, either:
    * Merge the new branch into `env/<stage|staging>`
      (if the current branch is `env/prod`).
    * Or merge the new branch into `develop`
      (if the current branch is `env/<stage|staging>`).
* Pushes to `env/<name>` (non-staging/production branches):
  * Run the docker build
  * Push the image to DockerHub, using the name of the environment as a tag.
* Pushes to `hotfix/<name>`:
  * Check if there is an open pull request for this branch:
    * If there is not: fail
    * If there is:
      * Check that the base branch is either `env/<stage|staging>` or `env/prod`
      * Check that the version in `package.json` has been updated between
        the base branch and HEAD.
      * Check that there is no existing tag for the current version in
        `package.json` (that will be created automatically when merged).
      * Check that the current HEAD of the base branch is an ancestor of the
        HEAD of the hotfix branch (i.e., that the hotfix is a fast-forward, and
        includes any other changes that may have been made to the target
        environment).
        * If not, post a comment suggesting rebasing the hotfix branch
          on-top of the tracking branch.
      * Run CI Tasks (unit-tests etc…)
      * Run the docker build
      * Push the image to DockerHub,
        using the version as the tag
        (regardless of whether the image already exists)
        * This allows us to deploy this image to a dev environment,
          and prevents us needing to rebuild the image once merged
          to the respective environment,
          ensuring we use the exact same image for both testing
          and the final deployment!
        * It also allows for updating the hotfixes with changes if it needs to
          be corrected.
* Pushes to `release/<version>`:
  * Check if there is an open pull request for this branch:
    * If there is not: fail
    * If there is:
      * Check that the base branch is `env/<stage|staging>`
      * Check that the version in `package.json` has been updated between
        the base branch and HEAD, and that it matches the name of the branch.
      * Check that there is no existing tag for the current version in
        `package.json` (that will be created automatically when merged).
      * Check that the current HEAD of the base branch is an ancestor of the
        HEAD of the release branch
        (i.e., that the release is a fast-forward,
        and includes any other changes that may have been made to the target
        environment).
        * If not, post a comment suggesting merging the base branch into the
          release branch.
          * *(this should only happen if a mergeback PR was not merged into
            `develop` before branching off the `release/` branch).
      * Run CI Tasks (unit-tests etc…)
      * Run the docker build
      * Push the image to DockerHub,
        using the version as the tag
        (regardless of whether the image already exists)
        * This allows us to deploy this image to a dev environment,
          and prevents us needing to rebuild the image once merged
          to the respective environment,
          ensuring we use the exact same image for both testing
          and the final deployment!
        * It also allows for updating the release with changes if it needs to
          be corrected.
* Pushes to `develop`:
  * Do nothing
* Pushes to all other branches
  * Check if there is an open pull request for this branch:
    * If there is not: fail
    * If there is:
      * Check that the base branch is **NOT** `env/<stage|staging>` or
        `env/prod`
        * If it is, post a comment detailing how changes to production or
          staging environments must be made.
      * Run CI Tasks (unit-tests etc…)
* TODO: Pull requests opened:
  * Re-Run all failed actions for the HEAD of the PR branch.
    * (we expect push actions to fail for branches when there is no pull request opened for them yet (to save on actions minutes)).

## Usage

To use the automated workflows of this repository, firstly create a
`workflow.json` configuration file somewhere in your repository, something like
this:

```json
{
  "stagingEnvironmentBranch": "env/staging",
  "repoType": "node",
  "developmentEnvironmentBranches": [],
  "docker": {
    "path": "docker",
    "args": {
        "commitSha": "COMMIT_SHA",
        "treeSha": "TREE_SHA"
    },
      "environmentVariables": {
        "commitSha": "HPC_ACTIONS_COMMIT_SHA",
        "treeSha": "HPC_ACTIONS_TREE_SHA"
    },
    "repository": "dockerhub-org/repo",
  },
  "ci": [],
  "mergebackLabels": ["mergeback"]
}
```

*(for full details of what you can put in your configuration file,
please see the [`config.ts` module](https://github.com/UN-OCHA/hpc-actions/blob/develop/action/src/config.ts))*

Then create a GitHub actions `.yml` workflow in `.github/workflows` that looks like this:

```yml
name: CI

on: [push]

jobs:
  workflow:
    name: Run Workflow
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@master
    - uses: UN-OCHA/hpc-actions@develop
      env:
        # this should point to the location of the file described above
        # relative to the root of your repo
        CONFIG_FILE: workflow.json
        # Add credentials as repository secrets for the docker registry you use
        # (it doesn't need to be DockerHub, but can be)
        DOCKER_USERNAME: ${{ secrets.DOCKER_USERNAME }}
        DOCKER_PASSWORD: ${{ secrets.DOCKER_PASSWORD }}
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Docker Images

For the docker image functionality to work properly,
you need to embed the tree sha and commit sha in your image
as environment variables.

If you use the same names as in the example config above,
you need to also add the following lines to your `Dockerfile`:

```Dockerfile
ARG COMMIT_SHA
ARG TREE_SHA
ENV HPC_ACTIONS_COMMIT_SHA $COMMIT_SHA
ENV HPC_ACTIONS_TREE_SHA $TREE_SHA
```

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