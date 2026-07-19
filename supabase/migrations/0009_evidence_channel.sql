-- Professor Viva — The Professor's Stage (Screen 5, Answer 5: "your first ten customers").
--
-- Answer 5 must name concrete, grounded acquisition CHANNELS — the specific
-- places where real demand for this idea was actually observed (a subreddit, a
-- forum thread, a niche marketplace, a review site), never invented ones. The
-- deep demand pass already reads those pages; this column captures WHERE each
-- demand claim was found so Answer 5 can be grounded in real channels instead
-- of the model guessing (03-AI Rules: no fabricated teasers / no invented
-- facts).
--
-- Shape (nullable — only demand-dimension claims carry it; other dimensions
-- and legacy rows stay null):
--   { "type": "subreddit" | "forum" | "marketplace" | "review_site" | "other",
--     "name": "r/somewhere",
--     "url":  "https://..." }
--
-- jsonb (not columns) because the set of channel attributes may grow and only
-- one dimension uses it; keeping it out of the fixed evidence columns avoids
-- five null columns on every non-demand row.

alter table evidence
  add column if not exists channel jsonb;
