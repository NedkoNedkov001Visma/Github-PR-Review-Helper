# PR Reviewer

A fast, local web app for reviewing GitHub pull requests — with special
treatment for AI bot noise. Runs entirely on your machine and talks to the
GitHub API using your own `gh` CLI token.

Built as an alternative to the real GitHub PR page when that page gets slow
under hundreds of AI-generated review comments.

## Why

Modern PRs often carry dozens of bot-generated review comments (Copilot,
Claude, Claude Code, GitHub Code Quality, GitHub Actions). GitHub's own
Conversation tab shows them all mixed in with human feedback, which makes
it hard to spot the comments that actually need your attention. This app:

- **Separates AI bot comments** into their own tab so the Conversation tab
  shows only human-relevant threads (and any AI comments a human replied to).
- **Highlights what's new since your last visit** with "New" badges on
  unseen comments and a "Collapse old" button.
- **Lets you drive CI from the same page**: see workflow runs for the PR,
  re-run failed jobs, and get a desktop notification when a run finishes.
- **Persists your per-PR state locally**: hidden files, collapsed threads,
  and seen comments all come back on the next visit.

## Features

### Index page
- Browse any GitHub repo's pull requests
- Filter by **state** (Open / Closed / All)
- Filter by **Author** and **Reviewer** (dropdown suggestions from
  the repo's contributors and assignees)
- Recent repositories remembered across sessions
- Per-PR card with title, labels, author avatar, requested-reviewer
  avatars, comment count, updated-at

### Conversation tab
- Chronological timeline of human-facing activity
- AI-only comments & threads removed — they're moved to the AI Comments tab
- Review comments show their **diff hunk context with line numbers**
- **Click a thread** → jumps to Files Changed, expands the file, and
  highlights the exact line
- Reply to review threads, resolve/unresolve them, post new conversation
  comments — all from the app
- Collapsible comments with **Expand all / Collapse all / Collapse old**
- **"New" badges** on comments added since your last visit
- Per-comment collapse state is persisted per PR

### AI Comments tab
- Every AI-only item: full reviews, sub-threads extracted from mixed
  reviews, bot issue comments
- Same collapse controls and "New" tracking as Conversation

### Files Changed tab
- Left-side **file tree** with collapsible folders, grouped paths, and
  status badges
- Each file has an eye icon to hide/show its diff
- Click a file in the tree → scrolls to it in the main pane
- **Expand all / Collapse all / Hide all** at the top
- Diff rendered with proper line numbers, add/delete coloring, and
  inline review comment threads
- Hidden and expand/collapse state is persisted per PR

### Actions tab
- Workflow runs + check runs for the PR's head commit, grouped by
  workflow name with the most recent run per workflow
- **Re-run** or **Re-run failed jobs** buttons for completed workflows
- Expandable per-run **jobs** list
- **Adaptive polling**: 5 s while any run is queued/in_progress,
  60 s when everything is done, skipped when the tab is hidden
- **Live transitions**: when a run completes the card flashes, a toast
  appears, and (with permission) a desktop notification fires
- DOM is patched in place on each poll — no flicker, open details
  sections stay open, scroll position is preserved
- Clicking **Re-run** optimistically flips the card to "In progress"
  immediately, then confirms from the server a couple seconds later

### App-level
- **Dark / light theme toggle** in the navbar (light by default; choice
  persisted to `localStorage`)
- **Clear data** modal lists everything stored locally (recent repos,
  theme, per-PR UI state) with per-category checkboxes
- **Bubble-up**: if a nested review reply is new, the parent review
  also gets a "New" badge so activity is visible at the top level

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

1. On the Index page, type a repo (`owner/repo`) and click **List PRs**.
2. Click any PR to open it — or paste a PR URL in the top input.
3. Switch between **Conversation**, **AI Comments**, **Files Changed**,
   and **Actions** tabs via the tab nav.

Recent repos and per-PR state (hidden files, collapsed comments, seen
comments, theme) are stored in your browser's `localStorage`. Clear it
any time with the trash-can **Clear data** button in the navbar.

## Tech stack

- **Backend**: Node.js + Express (single dependency). Proxies GitHub's
  REST and GraphQL APIs using the `gh` CLI's token.
- **Frontend**: plain HTML/CSS/ES modules — no framework, no build
  step, no bundler. Opens straight from disk in any modern browser.

## Project structure

```
Github-PR-Review-Helper/
  server.js                   # Express app + GitHub API proxy
  package.json
  public/
    index.html                # SPA shell
    style.css                 # All styling (CSS variables + light/dark)
    app.js                    # Router, state, tab glue, polling
    lib/
      api.js                  # Thin wrappers around /api/* endpoints
      classifier.js           # AI bot detection & thread classification
      timeline.js             # Builds the chronological PR timeline
      ui.js                   # Comment/review/thread rendering
      diff-renderer.js        # Files Changed: tree + diff tables
      actions-renderer.js     # Actions: workflow cards + patching
```

## Local storage keys

All keys are prefixed with `pr-reviewer-` so you can audit and clear
them in devtools. Listed here for reference:

| Key | Scope | Content |
|---|---|---|
| `pr-reviewer-recent-repos` | global | Array of recent `owner/repo` strings |
| `pr-reviewer-theme` | global | `"light"` or `"dark"` |
| `pr-reviewer-file-state:{owner}/{repo}/{n}` | per PR | hidden files, explicitly expanded/collapsed files, collapsed folders |
| `pr-reviewer-collapsed-comments:{owner}/{repo}/{n}` | per PR | Array of collapsed comment IDs |
| `pr-reviewer-seen-comments:{owner}/{repo}/{n}` | per PR | Array of comment IDs marked as seen |

## Known limitations

- Desktop notifications for finished workflows require the user to
  grant permission the first time a run completes while the page is
  open. We don't ask up front.
- The Actions polling pauses when the browser tab is hidden. When you
  return, it fetches immediately so you don't see stale data.
- `gh auth token` must be available in the shell that starts the
  server. The server doesn't re-prompt if the token expires mid-session —
  just restart it.
- Outdated review comments (where the referenced code has moved in the
  current diff) jump to the file section rather than a specific line,
  since there's no longer a matching line to point at.

## License

MIT — see [LICENSE](LICENSE).
