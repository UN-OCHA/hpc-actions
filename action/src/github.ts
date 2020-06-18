import { Octokit, RestEndpointMethodTypes } from '@octokit/rest';

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
  getOpenPullRequests: (params: {
    branch: string
  }) => Promise<RestEndpointMethodTypes["pulls"]["list"]["response"]>;
  reviewPullRequest: (params: {
    pullRequestNumber: number;
    state: 'approve' | 'reject' | 'comment-only';
    body: string;
  }) => Promise<void>;
}

export type PullRequest = RestEndpointMethodTypes["pulls"]["list"]["response"]["data"][number];

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
    getOpenPullRequests: async ({ branch }) => octokit.pulls.list({
      owner,
      repo,
      state: 'open',
      head: `${owner}:${branch}`,
    }),
    reviewPullRequest: async ({ pullRequestNumber, body, state }) => octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullRequestNumber,
      body,
      event: state === 'approve' ? 'APPROVE' : state === 'comment-only' ? 'COMMENT': 'REQUEST_CHANGES'
    }).then(() => {}),
  };
}
