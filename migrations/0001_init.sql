-- Latest probe of each domain: which doors (MCP, OpenAPI, llms.txt, markdown, feeds) are open. JSON in `doc`.
CREATE TABLE probes (
  domain TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL,
  reachable INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX probes_checked ON probes(checked_at);

-- One row per agent attempt: "I tried route R on domain D and got outcome O". These are the pheromone drops.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  route TEXT NOT NULL,      -- mcp | api | markdown | llms_txt | feed | http | browser | search | other
  outcome TEXT NOT NULL,    -- success | partial | blocked | captcha | login_wall | paywall | rate_limited | broken | empty | changed
  note TEXT,                -- <=200 chars, no URLs, injection-screened
  tool TEXT,                -- self-declared client, e.g. "claude-code", "playwright"
  steps INTEGER,
  seconds INTEGER,
  tokens INTEGER,
  reporter TEXT NOT NULL,   -- salted hash of the caller's IP bucket (raw IPs are never stored)
  source TEXT NOT NULL DEFAULT 'agent', -- agent | scout
  bucket INTEGER NOT NULL,  -- hour number, used to collapse accidental duplicates
  created_at INTEGER NOT NULL
);
CREATE INDEX reports_domain ON reports(domain, created_at DESC);
CREATE INDEX reports_recent ON reports(created_at DESC);
CREATE UNIQUE INDEX reports_dedupe ON reports(domain, route, outcome, reporter, bucket);

CREATE TABLE rate_limits (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
