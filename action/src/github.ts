import { Octokit } from '@octokit/rest';

interface GitHubParams {
  token: string;
  /**
   * Name of the repository in owner/repo format
   */
  githubRepo: string;
}

export type GitHubInit = (params: GitHubParams) => GitHubController;

interface PullRequestParameters {
  base: string;
  head: string;
  title: string;
}

export interface GitHubController {
  openPullRequest: (params: PullRequestParameters) => Promise<void>;
}

export const REAL_GITHUB: GitHubInit = ({ token, githubRepo }) => {
  const octokit = new Octokit({
    auth: token
  });

  const repoSplit = githubRepo.split('/');
  if (repoSplit.length !== 2) {
    throw new Error('Invalid value for repo: ' + githubRepo);
  }
  const [owner, repo] = repoSplit;

  return {
    openPullRequest: ({ base, head, title }) => octokit.pulls.create({
      owner,
      repo,
      title,
      head,
      base,
    }).then(() => {}),
  };
}
