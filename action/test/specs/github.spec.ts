import octokit = require('@octokit/rest');
import * as github from '../../src/github';

jest.mock('@octokit/rest');

describe('github', () => {
  it('Invalid Repo', () => {
    const mock = octokit.Octokit as unknown as jest.Mock;

    mock.mockClear();
    mock.mockReturnValue(null);

    try {
      github.REAL_GITHUB({
        githubRepo: 'oooorrrr',
        token: 'asdf',
      });
      throw new Error('Expected error to be thrown');
    } catch (error) {
      expect((error as { message: string }).message).toEqual(
        'Invalid value for repo: oooorrrr'
      );
    }

    expect({
      octokit: mock.mock.calls,
    }).toMatchSnapshot();
  });

  it('Open a pull request', async () => {
    const mock = octokit.Octokit as unknown as jest.Mock;

    const api = {
      pulls: {
        create: jest.fn().mockResolvedValue({
          data: {
            number: 123,
          },
        }),
      },
      issues: {
        update: jest.fn().mockResolvedValue(null),
      },
    };

    mock.mockClear();
    mock.mockReturnValue(api);

    await github
      .REAL_GITHUB({
        githubRepo: 'oooo/rrrr',
        token: 'asdf',
      })
      .openPullRequest({
        base: 'some-base',
        head: 'some-head',
        title: 'some-title',
        labels: ['mergeback'],
      });

    expect({
      octokit: mock.mock.calls,
      'pulls.create': api.pulls.create.mock.calls,
      'issues.update': api.issues.update.mock.calls,
    }).toMatchSnapshot();
  });

  it('Check existing pull requests', async () => {
    const mock = octokit.Octokit as unknown as jest.Mock;

    const api = {
      pulls: {
        list: jest.fn().mockResolvedValue([]),
      },
    };

    mock.mockClear();
    mock.mockReturnValue(api);

    await github
      .REAL_GITHUB({
        githubRepo: 'oooo/rrrr',
        token: 'asdf',
      })
      .getOpenPullRequests({
        branch: 'env/foo',
      });

    expect({
      octokit: mock.mock.calls,
      'pulls.list': api.pulls.list.mock.calls,
    }).toMatchSnapshot();
  });

  it('Submit a PR rejection', async () => {
    const mock = octokit.Octokit as unknown as jest.Mock;

    const api = {
      pulls: {
        createReview: jest.fn().mockResolvedValue([]),
      },
    };

    mock.mockClear();
    mock.mockReturnValue(api);

    await github
      .REAL_GITHUB({
        githubRepo: 'oooo/rrrr',
        token: 'asdf',
      })
      .reviewPullRequest({
        body: 'fooo',
        pullRequestNumber: 123,
        state: 'approve',
      });

    await github
      .REAL_GITHUB({
        githubRepo: 'oooo/rrrr',
        token: 'asdf',
      })
      .reviewPullRequest({
        body: 'fooo',
        pullRequestNumber: 123,
        state: 'reject',
      });

    await github
      .REAL_GITHUB({
        githubRepo: 'oooo/rrrr',
        token: 'asdf',
      })
      .reviewPullRequest({
        body: 'fooo',
        pullRequestNumber: 123,
        state: 'comment-only',
      });

    expect({
      octokit: mock.mock.calls,
      'pulls.createReview': api.pulls.createReview.mock.calls,
    }).toMatchSnapshot();
  });
});
