# GitLab MR Dashboard

Two Tampermonkey userscripts for gitlab.com merge request lists. They read
GitLab with the session of the person already signed in: no token to create,
nothing sent anywhere else. Their text follows GitLab's interface language
(English or French).

| Script | What it does | Changes anything? |
|---|---|---|
| `mr-dashboard.user.js` — **GitLab MR Dashboard** | Replaces a project's open MR list with a dashboard, with a switch back to GitLab's own list | No, read only |
| `mr-ci.user.js` — **GitLab MR CI** | A window with an MR's pipeline and run / retry / stop buttons, opened from the dashboard | **Yes**: it runs, retries and cancels real jobs |

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension.
2. Open each script's install link; Tampermonkey offers to install it:
   - [GitLab MR Dashboard](https://raw.githubusercontent.com/ririkiller/gitlab-mr-dashboard/main/mr-dashboard.user.js)
   - [GitLab MR CI](https://raw.githubusercontent.com/ririkiller/gitlab-mr-dashboard/main/mr-ci.user.js) (optional)

Tampermonkey then checks this repository for updates; each new version bumps
`@version`.
3. Open a project's merge request list (`https://gitlab.com/<group>/<project>/-/merge_requests`).

## GitLab MR Dashboard

- **Status tiles, also filters**: All, To review, To be tested, To merge, In
  progress. A second click on the active tile goes back to All.
- **To merge** (blue): approved, with no blocking label.
- **Release / Hotfix** (purple, first rows): MRs with the labels the
  settings name.
- **Personal tiles** for whoever is signed in: Pending reviews (reviewer, not
  yet approved), My MRs; and "To review, no reviewer".
- **MR table**: ⚠ when GitLab cannot merge it automatically, badges (draft,
  don't merge, review pending, my MR), status, pipeline status, reviewers,
  demo link, idle time (`3m`, `2h`, `5d`). Search box.
- **👁 Mark as seen**: a seen row is greyed out; new activity highlights it
  again. Marks are kept per browser and expire after 90 days.
- **⧉** copies a Claude Code review command for the MR; **↗** opens the CI
  window (when "GitLab MR CI" is installed and on for the project).
- **Review load** per reviewer, folded in one line under the table.
- Data loads with the page, on ↻ Refresh, and when coming back to the tab if
  it is over a minute old.

## GitLab MR CI

- Opens from ↗ in the dashboard, for projects whose `ciWindow` setting is on.
- Stages in pipeline order, jobs with a colored status glyph, durations,
  links; the demo environment's URL once the demo job succeeded.
- ▶ runs a manual job, ↻ retries a finished one, ■ cancels a running one or
  stops (a `*_stop` job). Stop, cancel and every job matching `prodJobs` ask
  for a confirmation first.
- Refreshes every 15 s while a job runs.

## Settings (⚙ in the dashboard)

The code holds neutral defaults only. A team's conventions live in settings
kept in each browser (`localStorage`, shared by both scripts), edited as JSON
in ⚙ Settings, with Copy JSON to share them. Updates of the scripts never
touch them.

```json
{
  "statusLabels": { "review": "Status::Needs review", "test": "Status::To be tested" },
  "blockingLabels": ["Status::*", "Don't merge"],
  "dontMergeLabel": "Don't merge",
  "releaseLabels": { "release": "Deploy::Release", "hotfix": "Deploy::Hotfix" },
  "defaults": {
    "demoEnvironmentPrefix": "",
    "demoJob": "",
    "reviewCommand": "",
    "prodJobs": "prod|prd|production|rollback",
    "ciWindow": false
  },
  "projects": {
    "my-group/my-project": {
      "demoEnvironmentPrefix": "review/",
      "demoJob": "deploy_review",
      "reviewCommand": "/review {iid}",
      "ciWindow": true
    }
  }
}
```

| Setting | Drives |
|---|---|
| `statusLabels` | the To review and To be tested groups (everything else is In progress) |
| `blockingLabels` | what keeps an approved MR from To merge (`Scope::*` matches a whole scope) |
| `dontMergeLabel` | the "Don't merge" badge |
| `releaseLabels` | the purple Release / Hotfix status (empty: none) |
| `demoEnvironmentPrefix` | demo environments, named `<prefix><branch slug>`: the Demo column and the CI window's demo link (empty: none) |
| `demoJob` | the job whose success means the demo is up |
| `reviewCommand` | what ⧉ copies, with `{iid}` and `{url}` (empty: a plain review request) |
| `prodJobs` | a regular expression: matching jobs ask before running |
| `ciWindow` | whether ↗ and the CI window exist for the project |

Labels are compared without their decoration: `Status::Needs review` also
matches `Status::🔎 Needs review`.

## Notes

- GitLab rebuilds its pages without reloading: the dashboard mounts again when
  the list comes back and removes itself on other pages. If GitLab's layout
  changes (`#content-body`), the switch may need a fix.
- Group and personal MR lists (`/groups/…`, `/dashboard/…`) are left as they are.
