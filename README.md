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
  