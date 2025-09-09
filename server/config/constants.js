// Server configuration constants
const SERVER_CONSTANTS = {
  PORTS: {
    DEFAULT: 9000,
    RETRY_ATTEMPTS: 5,
    RETRY_DELAY: 200
  },
  TIMEOUTS: {
    YTDLP_SEARCH: 7000,
    YTDLP_INFO: 10000,
    PROXY_FIRST_BYTE: 20000, // Increased from 3000 to 20000 for YouTube streaming
    SOCKET: 2000
  },
  CACHE: {
    INFO_TTL_MS: 6 * 60 * 60 * 1000, // 6 hours
    MAX_INFO_ENTRIES: 200,
    SEARCH_TTL_SECONDS: 3600 // 1 hour
  },
  LIMITS: {
    MAX_RESULTS: 200,
    DEFAULT_LIMIT: 20,
    MIN_SCORE: 40,
    COVERAGE_THRESHOLD: 0.8,
    SCORE_BOOST: 20
  },
  YOUTUBE_CACHE_TTL: 6 * 60 * 60 * 1000, // 6 hours
  SEARCH_CACHE_TTL: 3600 // 1 hour
};

// Data directory configuration
const CONFIG = {
  DATA_DIR: "data",
  DEFAULT_PORT: 9000,
  PORT: process.env.PORT || SERVER_CONSTANTS.PORTS.DEFAULT,
  CACHE_OPTIONS: {
    maxSize: 100,
    ttl: 3600000 // 1 hour
  }
};

module.exports = {
  SERVER_CONSTANTS,
  CONFIG
};
