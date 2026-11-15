# Contributing

- [Communication](#communication)
- [GitHub workflow](#github-workflow)
- [Open a Pull Request](#opening-a-pull-request)
- [Code Review](#code-review)
- [Best Practices](#best-practices)
- [Testing](#testing)
- [Security](#security)

HAX is open source, but many of the people working on it do so as their day job.
In order to avoid forcing people to be "at work" effectively 24/7, we want to establish some semi-formal protocols around development.
Hopefully, these rules make things go more smoothly.

As a potential contributor, your changes and ideas are welcome at any hour of the day or night, weekdays, weekends, and holidays.
Please do not ever hesitate to ask a question or send a pull request.

Beginner focused information can be found below in [Open a Pull Request](#opening-a-pull-request) and [Code Review](#code-review).

### Communication

Reporting issues? Our unified issue queue is a good place for this: https://github.com/haxtheweb/issues/issues
Need to discuss something via chat? Our [Discord can be joined here](https://discord.gg/aCGxmRHEJP).

## GitHub workflow

We work primarily using pull requests and forks. In order to work most effectively, we ask that you FORK any project you are wanting to contribute to in our ecosystem. After taking a fork, submit a pull request while pointing to the associated issue tied to this pull request.

## Opening a Pull Request

Pull requests are often called a "PR".
HAX generally follows the standard [github pull request](https://help.github.com/articles/about-pull-requests/) process.

Common new contributor PR issues are:
- Not referencing the issue that the PR resolves
- Not describing the scope of the solution effectively
- Include mentions (like @person) and [keywords](https://help.github.com/en/articles/closing-issues-using-keywords) which could close the issue (like fixes #xxxx) in commit messages.

## Code Review

To make it easier for your PR to receive reviews, consider the reviewers will need you to:

- Write [good commit messages](https://chris.beams.io/posts/git-commit/)
- Break large changes into a logical series of smaller patches which individually make easily understandable changes, and in aggregate solve a broader issue

When reviewing PRs from others [The Gentle Art of Patch Review](http://sage.thesharps.us/2014/09/01/the-gentle-art-of-patch-review/) suggests an iterative series of focuses which is designed to lead new contributors to positive collaboration without inundating them initially with nuances:

- Is the idea behind the contribution sound?
- Is the contribution architected correctly?
- Is the contribution polished?

Note: if your pull request isn't getting enough attention, you can use our [Discord channel](https://discord.gg/aCGxmRHEJP) to get help finding reviewers.

## Best practices

- Write clear and meaningful git commit messages.
- If the PR will *completely* fix a specific issue, include `fixes #123` in the PR body (where 123 is the specific issue number the PR will fix. This will automatically close the issue when the PR is merged.
- Make sure you don't include `@mentions` or `fixes` keywords in your git commit messages. These should be included in the PR body instead.
- When you make a PR for small change (such as fixing a typo, style change, or grammar fix), please squash your commits so that we can maintain a cleaner git history.
- Make sure you include a clear and detailed PR description explaining the reasons for the changes, and ensuring there is sufficient information for the reviewer to understand your PR.
- Additional Readings: 
    - [chris.beams.io/posts/git-commit/](https://chris.beams.io/posts/git-commit/)
    - [github.com/blog/1506-closing-issues-via-pull-requests ](https://github.com/blog/1506-closing-issues-via-pull-requests)
    - [davidwalsh.name/squash-commits-git ](https://davidwalsh.name/squash-commits-git)
    - [https://mtlynch.io/code-review-love/](https://mtlynch.io/code-review-love/)

## Testing

Unit tests are ideal but not required to be written for proposed changes and enhancements.

### Mutation testing (weekly, report-only)

Mutation testing checks that the tests of the outline designer's bulk save would notice a broken save. [Stryker](https://stryker-mutator.io) makes one small change at a time (flips a condition, drops a statement, empties a string) to the save-critical code and reruns the tests that cover it. A change no test notices is a surviving mutant: a gap in the saveOutline tests.

- Scope (`mutate` in `stryker.config.json`): `src/siteRoutes/v1/routes/saveOutline.js` and the write helpers it calls: `JSONOutlineSchema` `save()` through the tree ordering, `JSONOutlineSchemaItem.writeLocation()`, `HAXCMSSite` `updateNode()`, `deleteNode()` and `getUniqueSlugName()`. Line ranges are used for the two large files, so check them when those methods move.
- Tests (`tap.testFiles`): `test/unit/save-outline-*.test.cjs`, `test/unit/fault-injection-save-outline.test.cjs` and `test/unit/json-outline-schema*.test.cjs`, run per file with per-file coverage, so each mutant only reruns the files that reach it.
- Run it locally with `yarn test:mutation`. It takes a while (see the PR that added it for timings). The HTML report is written to `reports/mutation/index.html`; `node scripts/mutation-summary.js` prints the score and the surviving mutants.
- CI: `.github/workflows/mutation-testing.yml` runs it every Sunday and on demand (workflow_dispatch). It is advisory: it never fails a build and never opens issues or PRs. The score and the surviving mutants are in the job summary; the HTML report is the `mutation-report` artifact.

To act on a surviving mutant, add or tighten a test so that change would fail it. If a mutant cannot change behavior (an equivalent mutant), leave a `// Stryker disable next-line <mutator>: <reason>` comment on that line. To widen or narrow what is mutated, edit `mutate` and `tap.testFiles` in `stryker.config.json`.

## Security

Please don't report security vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md) and submit a private advisory at https://github.com/haxtheweb/issues/security/advisories/new. If you'd like to talk it through first, reach the core team privately on [Discord](https://discord.gg/aCGxmRHEJP) or at hax@psu.edu.
