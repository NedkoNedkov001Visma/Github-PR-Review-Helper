# PR Reviewer

A fast, local web app for reviewing GitHub pull requests — with special
treatment for AI bot noise. Runs entirely on your machine and talks to the
GitHub API using your own `gh` CLI token.

Built as an alternative to the real GitHub PR page when that page gets slow
under hundreds of AI-generated review comments, and tuned for a workflow
where you want to triage many PRs quickly without leaving the keyboard.

## Why

Modern PRs often carry dozens of bot-generated review comments (Copilot,
Claude, Claude Code, GitHub Code Quality, GitHub Actions). GitHub's own
Conversation tab shows them all mixed in with human feedback, which makes
it hard to spot the comments that actually need your attention. This app:

- **Separates AI bot comments** into their own tab so the Conversation tab
  shows only human-relevant threads (and any AI comments a human replied to).
- **Highlights what's new since your last visit** with "New" badges on
  unseen comments and a "Collapse old" button.
- **Drives common PR actions from the same page** — approve, merge, resolve
  threads, reply, comment, re-run failing CI — without round-tripping to GitHub.
- **Persists your per-PR state locally** so hidden files, collapsed threads,
  seen comments, viewed-file ratchets, and filter prefs come back next visit.

## Features

### Index page (browse a repo's PRs)

- Type any `owner/repo` (or full GitHub URL) to list its pull requests
- Filter by **state**: Open / Closed / All
- **Multi-select user filters** with searchable popovers:
  - **Authors** — PRs created by any of the selected users
  - **Reviewers** — PRs where any of the selected users has reviewed or
    is requested as reviewer
  - **Participants** — author **or** reviewer **or** assignee
  - Selections batch: the PR list refetches once when you close the popover
- **Highlight new activity** toggle — when on, every card whose
  `updated_at` has moved since you last opened that PR gets a blue
  **New** badge and a soft accent tint. Cards you've never opened
  aren't marked, so the first time you flip it on you don't drown in
  badges. Comparison is local (no API calls), state is global.
- Recent repositories remembered across sessions as one-click chips
- PR cards show title, labels, author avatar, requested-reviewer avatars,
  comment count, and updated-at
- The current-repo breadcrumb (`owner / repo`) routes back to the
  in-app PR list rather than to github.com; a small icon next to it
  is the explicit "open on GitHub" action

### PR header

- **State badge**: Open / Closed / Merged
- **Review-state badge**: Approved / Changes requested / Review required —
  computed from the latest non-comment review per reviewer, with the
  reviewer names in the tooltip
- **Approve** button — only shown when the current user is a reviewer
  (assigned or has already reviewed) and not the PR author. Disabled and
  labelled "Approved" if the user already approved.
- **Merge** is a split button — main click uses the saved method for
  the repo, caret opens a dropdown with **Create merge commit** /
  **Squash and merge** / **Rebase and merge**. Choice is persisted per
  repo, so once you pick what your repo allows you don't see "merge
  commits not allowed" again. Enabled only once the PR has at least
  one approval and no outstanding "Changes requested"; disabled with
  a precise reason ("Waiting for an approval", "Changes requested",
  "Merge conflicts", "PR is in draft") otherwise. Confirms before
  merging with the chosen verb in the prompt. The caret stays
  clickable while the main button is disabled so you can pre-select
  your method before approval lands.
- The PR number (`#1234`) is a direct link to the PR on GitHub
- Branch info, +/- line stats, breadcrumb back to the in-app repo
  PR list (clicking owner *or* repo lands you on the same page)

### Conversation tab

- Chronological timeline of human-facing activity
- AI-only comments & threads filtered out — they live in **AI Comments**
- Review-comment threads show their **diff hunk with line numbers**
- **Sort** by Time created, Last updated, or Author (asc/desc, persisted
  globally)
- **Filter** by author (multi-select) and by "with replies" / "without
  replies" — filters are persisted per PR
- Reply to threads, post new conversation comments, **resolve / unresolve**
  review threads — all from the app
- **Resolve / unresolve actually works** — uses GitHub's GraphQL mutation
  with the right `PullRequestReviewThread` node ID
- **Resolved threads collapse by default**; the summary row keeps the
  file path + a "Resolved" pill + comment count visible. Click anywhere
  on the summary (or the chevron) to expand. Resolving via the button
  auto-collapses; unresolving auto-expands.
- **Outdated** threads get a pill too
- **Auto-linked commit SHAs** inside comment markdown — bare hex strings
  like `cbf28e4` become links that open the commit in-app
- **Collapse all / Collapse old / Expand all** bulk actions
- **"New" badges** on comments added since your last visit. If a child
  reply is new, the parent thread also gets the badge so activity is
  visible without expanding everything.
- Per-comment collapse state is persisted per PR

### AI Comments tab

- Every AI-only item: full reviews, sub-threads extracted from mixed
  reviews, bot issue comments
- Same sort / filter / collapse / "New" controls as Conversation

### Commits tab

- Ordered list of every commit on the PR
- Date-grouped headers (`MON, APR 28, 2026`) for quick visual scanning
- **Sort by date**: oldest-first / newest-first toggle, persisted globally
- Each commit shows author avatar + login, subject, expand toggle for the
  message body, authored-time, and 7-char SHA
- Click the commit subject or SHA chip to open the **in-app commit page**

### In-app commit page

- URL hash `#owner/repo/commit/<sha>`
- Header card: subject, optional message body, author + relative time,
  full SHA, parent commits (linked to their own in-app pages), an
  "open on GitHub" external link, and +/- stats
- Files changed for the commit rendered with the same diff renderer
  as the PR's Files Changed tab
- Per-commit viewed/collapse state is keyed by SHA, independent from PRs

### Preview modals (no navigation)

- **Commit preview modal**: click an auto-linked SHA inside a comment
  → wide modal pops up with the commit header + file diffs over the
  current page. Hash doesn't change.
- **File diff preview modal**: click a diff hunk inside a comment thread
  → wide modal pops up with the file's full diff (with inline review
  threads) and scrolls to the comment's row.
- Both modals: max-height 80vh, file/commit header pinned above an
  internal scroll area, close on backdrop click / × button / Escape.
  Body scroll is locked while open.
- **Modifier-key clicks pass through** so cmd/ctrl/middle-click still
  open the link normally in a new tab.

### Files Changed tab

- Left-side **file tree** with collapsible folders, single-child folders
  collapsed into one label, status badges, and per-row stats
- **Tight indentation** so deeply-nested paths still fit
- **Custom hover tooltip** on tree rows shows the full path with a 200ms
  delay (replacement for the slow native `title`); follows the cursor,
  clamps to viewport edges
- Each tree row has an eye icon to hide/show its diff and a checkbox to
  mark it as **viewed**
- **"Changed since viewed"** indicator on the tree row + diff section
  if the file's SHA has changed since you last marked it viewed
- Click a file in the tree → scrolls to it in the main pane and expands it
- **Sticky bulk-action toolbar** above the diffs:
  Expand all / Collapse all / Hide all / **Hide comments**
- "Hide comments" hides every inline review-comment row in every diff —
  preference is global and persisted
- Diffs render with proper line numbers, add/delete colouring, and
  inline review-comment threads at the right positions
- Hidden files, expand/collapse states, collapsed folders, and viewed
  SHAs are persisted per PR

### Actions tab

- Workflow runs + check runs for the PR's head commit, grouped by
  workflow name with the most recent run per workflow
- **Re-run** or **Re-run failed jobs** buttons for completed workflows
- Expandable per-run **jobs** list
- **Adaptive polling**: 5 s while any run is queued/in_progress,
  60 s when everything is done, skipped when the tab is hidden
- **Live transitions**: when a run completes the card flashes, a toast
  appears, and (with permission) a desktop notification fires
- DOM is patched in place on each poll — no flicker, expanded details
  stay expanded, scroll position is preserved
- Clicking **Re-run** optimistically flips the card to "In progress"
  immediately, then confirms from the server a couple seconds later

### App-level

- **Dark / light theme toggle** in the navbar (light by default; choice
  persisted to `localStorage`)
- **URL hash drives the active tab** (`#owner/repo/123/files-changed`)
  so reload / bookmark / browser-back restores exactly where you were
- **Active tab is persisted** so first-load defaults match your last view
- **Highlight new items**: subtle blue tint on new comments and on
  files that have changed since you marked them viewed
- **Clear data** modal lists every category of locally-stored data
  (recent repos, theme, per-PR UI state) with per-category checkboxes
- "Bubble-up": if a nested review reply is new, the parent review also
  gets a "New" badge so activity surfaces at the top level

## Prerequisites

- **Node.js 18+** (uses native `fetch`, no polyfills needed)
- **GitHub CLI (`gh`)** installed and authenticated — the server runs
  `gh auth token` at startup to get your credentials

To check you're set up:

```bash
node --version      # should be 18+
gh auth status      # should show you're logged in
```

If `gh` isn't authenticated yet:

```bash
gh auth login
```

## Install and run

```bash
git clone https://github.com/NedkoNedkov001Visma/Github-PR-Review-Helper.git
cd Github-PR-Review-Helper
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

You should see:

```
PR Reviewer running at http://localhost:3000
GitHub token OK
```

If it says `Failed to get GitHub token`, run `gh auth login` and restart.

### Using it

1. On the Index page, type a repo (`owner/repo`) and click **List PRs**,
   or paste a PR URL in the top input to jump straight to a PR.
2. Filter the list by Author / Reviewer / Participant if you want to
   narrow it down — the popovers are searchable.
3. Click any PR to open it. The header shows the review state, plus
   Approve and Merge buttons when applicable.
4. Switch between **Conversation**, **AI Comments**, **Commits**,
   **Files Changed**, and **Actions** via the tab nav.
5. In comments, click any auto-linked commit SHA or any file-diff hunk
   to preview it in a modal without leaving the page.

Recent repos and per-PR state are stored in your browser's `localStorage`.
Clear it any time with the **Clear data** button in the navbar.

## Tech stack

- **Backend**: Node.js + Express (single dependency). Proxies GitHub's
  REST and GraphQL APIs using the `gh` CLI's token.
- **Frontend**: plain HTML/CSS/ES modules — no framework, no build
  step, no bundler. Opens straight from disk in any modern browser.

## Project structure

```
Github-PR-Review-Helper/
  server.js                       # Express app + GitHub API proxy
  package.json
  public/
    index.html                    # SPA shell
    style.css                     # All styling (CSS variables + light/dark)
    app.js                        # Router, state, tab glue, polling, modals
    lib/
      api.js                      # Thin wrappers around /api/* endpoints
      classifier.js               # AI bot detection & thread classification
      timeline.js                 # Builds the chronological PR timeline
      ui.js                       # Comment/review/thread rendering, header,
                                  #   markdown (incl. SHA auto-linking)
      diff-renderer.js            # Files Changed: tree + diff tables;
                                  #   also renderFilePreview for the modal
      commits-renderer.js         # Commits tab list with date groups + sort
      commit-detail-renderer.js   # In-app commit page header + diffs
      actions-renderer.js         # Actions: workflow cards + patching
```

## Local storage keys

All keys are prefixed with `pr-reviewer-` so you can audit and clear
them in devtools. Listed here for reference:

| Key | Scope | Content |
|---|---|---|
| `pr-reviewer-recent-repos` | global | Array of recent `owner/repo` strings |
| `pr-reviewer-theme` | global | `"light"` or `"dark"` |
| `pr-reviewer-sort` | global | `{ field, direction }` for Conversation / AI Comments |
| `pr-reviewer-commit-sort` | global | `"asc"` / `"desc"` for the Commits tab |
| `pr-reviewer-hide-diff-comments` | global | `"1"` if review comments are hidden in diffs |
| `pr-reviewer-active-tab` | global | Tab to restore on first PR load |
| `pr-reviewer-highlight-new-activity` | global | `"1"` if the PR-list "Highlight new activity" toggle is on |
| `pr-reviewer-merge-method:{owner}/{repo}` | per repo | Last-chosen merge method: `"merge"` / `"squash"` / `"rebase"` |
| `pr-reviewer-pr-last-visited:{owner}/{repo}/{n}` | per PR | PR's `updated_at` at the moment you last opened it (drives the "New" highlight) |
| `pr-reviewer-file-state:{owner}/{repo}/{n}` | per PR or commit | hidden files, expanded/collapsed files, collapsed folders, viewed SHAs |
| `pr-reviewer-collapsed-comments:{owner}/{repo}/{n}` | per PR | Array of collapsed comment IDs |
| `pr-reviewer-seen-comments:{owner}/{repo}/{n}` | per PR | Array of comment IDs marked as seen |
| `pr-reviewer-filters:{owner}/{repo}/{n}` | per PR | Comment-tab filter prefs (authors, reply mode) |

## Known limitations

- **Single-user, single-machine**: the server uses your local `gh` CLI
  token. There's no auth, no sessions, no multi-user support — anyone
  with localhost access can act as you. Don't expose it publicly.
- **Token refresh**: if `gh auth token` becomes invalid mid-session
  (e.g. you logged out elsewhere), the server doesn't re-prompt. Just
  restart it.
- **Outdated review comments** (where the referenced code has moved in
  the current diff) jump to the file section rather than a specific
  line, since there's no longer a matching line to point at.
- **Desktop notifications** for finished workflows require browser
  permission, granted on the first run that completes while you're
  watching the tab. Permission isn't requested up front.
- **Actions polling** pauses while the browser tab is hidden; resumes
  immediately on focus.
- **GraphQL thread fetch** is paginated up to 20 pages (≈ 2000 threads).
  PRs with more threads will show only the first 2000 as resolved/
  unresolved correctly; beyond that, those threads render as if
  unresolved (the resolve button still works for the threads we did
  fetch).

## License

MIT — see [LICENSE](LICENSE).
