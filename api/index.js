// Vercel serverless entry point. Any file under /api becomes a function;
// this re-exports the existing Express app from server.js unchanged.
module.exports = require('../server');

// Function-level config, read directly by Vercel's Node runtime regardless
// of the builds/routes config in vercel.json. The free-verdict quick pass
// took ~25s in the last live run; give it headroom under the default
// (10-15s) timeout.
module.exports.config = { maxDuration: 60 };
