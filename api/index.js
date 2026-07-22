// Vercel serverless entry point. Any file under /api becomes a function;
// this re-exports the existing Express app from server.js unchanged.
module.exports = require('../server');
