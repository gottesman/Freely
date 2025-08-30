const path = require('path');

module.exports = {
  // This tells Webpack we're building for Node.js, not a browser.
  target: 'node',
  // The entry point of your server
  entry: {
    'server.bundle': './server/torrent-server.js',
    'torrent-get-files': './server/torrent-get-files.js'
  },
  output: {
    path: path.resolve(__dirname, 'src-tauri', 'server-dist'),
    // --- CHANGE #2: Use a placeholder for the filename ---
    // [name] will be replaced by the keys from the 'entry' object above.
    filename: '[name].js',
  },
  externals: {
    'utp-native': 'commonjs utp-native'
  },
  // In node, we want __dirname to be the real directory name
  node: {
    __dirname: false,
  },
  mode: 'production', // 'production' or 'development' for more readable output
};