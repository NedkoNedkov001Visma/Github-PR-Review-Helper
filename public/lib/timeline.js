/**
 * timeline.js
 *
 * Merges issue comments and reviews into a single sorted timeline.
 */

/**
 * Build a unified, chronologically sorted timeline from issue comments
 * and pull-request reviews.
 *
 * @param {Object}  params
 * @param {Array}   params.issueComments - Raw issue comments from the GitHub API.
 * @param {Array}   params.reviews       - Raw reviews from the GitHub API.
 * @param {Array}   [params.reviewComments] - Raw review comments, used to detect
 *                                            ghost reviews (state COMMENTED, empty
 *                                            body, no associated review comments).
 * @returns {Array<{ type: string, data: Object, timestamp: string }>}
 *          Sorted ascending by timestamp.
 */
export function buildTimeline({ issueComments = [], reviews = [], reviewComments = [] }) {
  const entries = [];

  // --- Issue comments ---------------------------------------------------
  for (const comment of issueComments) {
    entries.push({
      type: 'issue_comment',
      data: comment,
      timestamp: comment.created_at,
    });
  }

  // Build a set of review IDs that have at least one review comment so we
  // can detect "ghost" reviews (COMMENTED + empty body + no threads).
  const reviewIdsWithComments = new Set(
    reviewComments.map((rc) => rc.pull_request_review_id),
  );

  // --- Reviews ----------------------------------------------------------
  for (const review of reviews) {
    // Skip reviews without a submission timestamp (drafts / pending).
    if (review.submitted_at === null || review.submitted_at === undefined) {
      continue;
    }

    // Filter out ghost reviews: state COMMENTED, empty body, and no
    // associated review comments.
    const isGhost =
      review.state === 'COMMENTED' &&
      (!review.body || review.body.trim() === '') &&
      !reviewIdsWithComments.has(review.id);

    if (isGhost) {
      continue;
    }

    entries.push({
      type: 'review',
      data: review,
      timestamp: review.submitted_at,
    });
  }

  // --- Sort ascending by timestamp --------------------------------------
  entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return entries;
}
