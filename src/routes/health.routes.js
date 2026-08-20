const express = require('express');

const router = express.Router();

router.get('/', (_req, res) => {
  res.status(200).json({ success: true, status: 'ok', message: 'F-Grade backend is running' });
});

module.exports = router;
