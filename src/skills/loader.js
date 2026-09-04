const fs = require('fs').promises;
const path = require('path');
const { env } = require('../config/env');

async function listSkills() {
  const skillsDir = env.skillsPath;
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(d => d.name);
  } catch (err) {
    return [];
  }
}

async function listFiles(skillName) {
  const skillDir = path.join(env.skillsPath, skillName);
  try {
    const entries = await fs.readdir(skillDir, { withFileTypes: true });
    return entries.filter(e => e.isFile()).map(f => f.name);
  } catch (err) {
    return [];
  }
}

async function readFile(skillName, fileName) {
  const safeFile = path.basename(fileName);
  const filePath = path.join(env.skillsPath, skillName, safeFile);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content;
  } catch (err) {
    return null;
  }
}

module.exports = { listSkills, listFiles, readFile };
