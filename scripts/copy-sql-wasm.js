const fs = require('fs')
const path = require('path')

const fromDir = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist')
const toDir = path.join(__dirname, '..', 'public')

if (!fs.existsSync(fromDir)) {
  console.error('sql.js not installed. Run `npm install` first.')
  process.exit(1)
}

if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true })

const files = ['sql-wasm.js', 'sql-wasm.wasm']
for (const f of files) {
  const src = path.join(fromDir, f)
  const dest = path.join(toDir, f)
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest)
    console.log('Copied', src, '->', dest)
  } else {
    console.warn('Missing', src)
  }
}

console.log('sql-wasm assets copied to public/')
