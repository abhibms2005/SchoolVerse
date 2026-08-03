'use strict';
const express = require('express');
const { getStats } = require('../src/stats');

const router = express.Router();

// GET /api/stats — real aggregates (public read-only for the landing preview)
router.get('/', (req, res) => {
  res.json(getStats(req.db));
});

module.exports = router;
