const express = require('express');
const { listSkills, listFiles, readFile } = require('../skills/loader');

function createSkillsRoutes() {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const skills = await listSkills();
      res.json({ success: true, skills });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:skill', async (req, res, next) => {
    try {
      const files = await listFiles(req.params.skill);
      res.json({ success: true, files });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:skill/file', async (req, res, next) => {
    try {
      const name = req.query.name;
      if (!name) return res.status(400).json({ success: false, error: { code: 'MISSING_NAME', message: 'Query param `name` is required.' } });
      const content = await readFile(req.params.skill, name);
      if (content === null) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'File not found.' } });
      res.type('text/plain').send(content);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createSkillsRoutes;
