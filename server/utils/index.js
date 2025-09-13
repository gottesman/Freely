/**
 * Utilities module - Main entry point
 * Re-exports all utility functions from organized modules
 */

// Import all utility modules
const stringUtils = require('./stringUtils');
const scoring = require('./scoring');
const helpers = require('./helpers');
const searchCache = require('./searchCache');

// Re-export everything for backward compatibility
module.exports = {
  // String utilities
  ...stringUtils,
  
  // Scoring utilities
  ...scoring,
  
  // Helper utilities  
  ...helpers,
  
  // Search cache utilities
  ...searchCache
};
