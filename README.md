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
  * Running unit-tests and other CI checks against the correct commits
  * Creating and pushing release tags



