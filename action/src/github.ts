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
  labels: string[];
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
    openPullRequest: async ({ base, head, title, labels }) => {
      const pull = await octokit.pulls.create({
        owner,
        repo,
        title,
        head,
        base,
      });
      if (labels.length > 0) {
        await octokit.issues.update({
          owner,
          repo,
          issue_number: pull.data.number,
          labels
        });
      }
    },
  };
}
