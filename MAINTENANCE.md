# Keeping this profile up to date

GitHub displays the root `README.md` on [my profile](https://github.com/HYHBalci) because this public repository has the same name as my account. Editing that file updates the profile.

The banner and graphs have light and dark variants. GitHub picks the appropriate version using the README's `<picture>` elements. The SVGs are stored here, so visitors do not depend on an external statistics service.

## Automatic graphs

[Refresh profile graphs](https://github.com/HYHBalci/HYHBalci/actions/workflows/update-profile.yml) runs daily at 06:23 UTC and when its generator changes. It can also be started with **Actions → Refresh profile graphs → Run workflow**.

The workflow uses GitHub's automatically supplied repository token. There is no personal access token or extra secret to configure. It needs `contents: write` to save the generated SVGs in this repository. Official actions are pinned to verified release commit hashes.

The generator collects the public profile, aggregate contributions visible to that token, and publicly owned repositories. It never collects private repository names or source files. The activity calendar can include anonymous private contribution counts if the account has chosen to make them visible. Contribution-type counters are GitHub's visible aggregate counts; they need not add up to the calendar total, which can also count other events.

Language percentages are shares of code bytes across original public repositories. Forks, archived repositories, and this profile repository are excluded. They are not a measure of skill, coding time, or all my work. Public repository totals include forks and this profile; stars count original public project repositories.

If the API fails, the workflow fails before replacing the existing graphs, leaving the last successful version visible. GitHub may delay scheduled jobs. GitHub can also disable public scheduled workflows after 60 days without repository activity; if that happens, open the workflow page, enable it, and run it manually.

## Local checks

Use Node.js 24 or later; there are no package dependencies.

```sh
node --test scripts/*.test.mjs
```

The public workflow is the preferred way to refresh live graphs. A personal token can have broader access than the workflow's token, so avoid publishing snapshots collected with private-data permissions.

## References

- [GitHub profile README requirements](https://docs.github.com/en/account-and-profile/how-tos/profile-customization/managing-your-profile-readme)
- [Theme-aware README images](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/quickstart-for-writing-on-github)
- [Automatic GitHub Actions token](https://docs.github.com/en/actions/concepts/security/github_token)
- [Scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
