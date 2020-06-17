
export type GitHubInit = () => GitHubController;

interface PullRequestParameters {
  base: string;
  head: string;
  title: string;
}

export interface GitHubController {
  openPullRequest: (params: PullRequestParameters) => Promise<void>;
}

export const REAL_GITHUB: GitHubInit = () => ({
  openPullRequest: () => Promise.reject(new Error('not yet implemented')),
});
