#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Update version across all project files
 * Usage: node scripts/update-version.js <new-version>
 * Example: node scripts/update-version.js 1.0.0
 */

const newVersion = process.argv[2];

if (!newVersion) {
  console.error('Please provide a version number');
  console.log('Usage: node scripts/update-version.js <new-version>');
  console.log('Example: node scripts/update-version.js 1.0.0');
  process.exit(1);
}

// Validate version format (basic semver)
const versionRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;
if (!versionRegex.test(newVersion)) {
  console.error(`Invalid version format: ${newVersion}`);
  console.error('Please use semantic versioning format (e.g., 1.0.0, 1.0.0-beta.1)');
  process.exit(1);
}

const rootDir = path.join(__dirname, '..');

// Files to update with their update strategies
const filesToUpdate = [
  {
    file: 'package.json',
    type: 'json',
    path: ['version']
  },
  {
    file: 'src-tauri/Cargo.toml',
    type: 'toml',
    pattern: /^version = ".*"$/m,
    replacement: `version = "${newVersion}"`
  },
  {
    file: 'src-tauri/tauri.conf.json',
    type: 'json',
    path: ['version']
  },
  {
    file: 'src/core/accessEnv.tsx',
    type: 'regex',
    pattern: /APP_USER_AGENT: "FreelyPlayer\/[^"]+"/,
    replacement: `APP_USER_AGENT: "FreelyPlayer/${newVersion}"`
  },
  {
    file: 'src/core/Genius.tsx',
    type: 'regex',
    pattern: /const DEFAULT_USER_AGENT = 'FreelyPlayer\/[^']+'/,
    replacement: `const DEFAULT_USER_AGENT = 'FreelyPlayer/${newVersion}'`
  }
];

function updateJsonFile(filePath, pathArray, newValue) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(content);
    
    // Navigate to the nested property
    let current = json;
    for (let i = 0; i < pathArray.length - 1; i++) {
      current = current[pathArray[i]];
    }
    current[pathArray[pathArray.length - 1]] = newValue;
    
    // Write back with proper formatting
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
    return true;
  } catch (error) {
    console.error(`Error updating JSON file ${filePath}:`, error.message);
    return false;
  }
}

function updateTextFile(filePath, pattern, replacement) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const updatedContent = content.replace(pattern, replacement);
    
    if (content === updatedContent) {
      // Check if the target value is already present
      if (content.includes(replacement.split('=')[1]?.trim() || replacement.split(':')[1]?.trim() || '')) {
        console.log(`  Already at target version in ${path.basename(filePath)}`);
        return true; // Not an error, just already correct
      }
      console.warn(`Warning: No changes made to ${filePath} - pattern might not match`);
      return false;
    }
    
    fs.writeFileSync(filePath, updatedContent);
    return true;
  } catch (error) {
    console.error(`Error updating file ${filePath}:`, error.message);
    return false;
  }
}

console.log(`Updating version to ${newVersion}...`);

// Show current version from package.json
try {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const currentVersion = packageJson.version;
  if (currentVersion === newVersion) {
    console.log(`Already at version ${newVersion}. No changes needed.`);
    process.exit(0);
  }
  console.log(`Current version: ${currentVersion} → ${newVersion}`);
} catch (error) {
  console.warn('Could not read current version from package.json');
}

let updateCount = 0;
let errorCount = 0;

for (const fileConfig of filesToUpdate) {
  const filePath = path.join(rootDir, fileConfig.file);
  
  if (!fs.existsSync(filePath)) {
    console.warn(`Warning: File not found: ${fileConfig.file}`);
    continue;
  }
  
  console.log(`Updating ${fileConfig.file}...`);
  
  let success = false;
  
  switch (fileConfig.type) {
    case 'json':
      success = updateJsonFile(filePath, fileConfig.path, newVersion);
      break;
    case 'toml':
    case 'regex':
      success = updateTextFile(filePath, fileConfig.pattern, fileConfig.replacement);
      break;
    default:
      console.error(`Unknown update type: ${fileConfig.type}`);
      errorCount++;
      continue;
  }
  
  if (success) {
    updateCount++;
    console.log(`✓ Updated ${fileConfig.file}`);
  } else {
    errorCount++;
  }
}

console.log(`\nVersion update complete!`);
console.log(`✓ ${updateCount} files updated successfully`);
if (errorCount > 0) {
  console.log(`✗ ${errorCount} files had errors`);
}

// Remind user about package-lock.json
console.log(`\nNote: Run 'npm install' to update package-lock.json`);

if (errorCount === 0) {
  console.log(`\nAll files updated to version ${newVersion} 🎉`);
  process.exit(0);
} else {
  process.exit(1);
}
