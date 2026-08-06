'use strict';
const express = require('express');
const { predictStaffing } = require('../src/staffing-predictor');

const router = express.Router();

// GET /api/staffing/predictions?limit=5 (authed) — heuristic outlook computed
// from real attendance + timetable + curriculum data at request time.
router.get('/predictions', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 25);
  res.json({
    predictions: predictStaffing(req.db, limit),
    generated_at: new Date().toISOString(),
  });
});

module.exports = router;
