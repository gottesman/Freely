const path = require('path');

module.exports = {
  // This tells Webpack we're building for Node.js, not a browser.
  target: 'node',
  // The entry point of your server
  entry: {
    'server.bundle': './server/server.js'
  },
  output: {
    path: path.resolve(__dirname, 'src-tauri', 'server-dist'),
    // --- CHANGE #2: Use a placeholder for the filename ---
    // [name] will be replaced by the keys from the 'entry' object above.
    filename: '[name].js',
  },
  externals: {
    // Externalize native modules we cannot bundle; native modules are aliased to shims instead
  },
  resolve: {
    alias: {
      'utp-native': path.resolve(__dirname, 'server', 'utils', 'shims', 'utp-native.js'),
      'node-datachannel': path.resolve(__dirname, 'server', 'utils', 'shims', 'node-datachannel.js')
    }
  },
  module: {
    parser: {
      javascript: {
        exprContextCritical: false, // Suppress "the request of a dependency is an expression" critical warning
      }
    }
  },
  ignoreWarnings: [
    // Extra safety: ignore any remaining dynamic expression warning from express view loader
    { module: /express[\\/]lib[\\/]view\.js/, message: /the request of a dependency is an expression/ }
  ],
  // In node, we want __dirname to be the real directory name
  node: {
    __dirname: false,
  },
  mode: 'production', // 'production' or 'development' for more readable output
};