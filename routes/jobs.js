// routes/jobs.js
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

router.get('/', async (req, res) => {
  try {
    if (!process.env.RAPIDAPI_KEY) {
      return res.status(500).json({ error: "Server configuration error" });
    }

    const params = new URLSearchParams({
      limit: req.query.limit || "20",
      title_filter: req.query.keywords || "",
      location_filter: req.query.locationName || "",
      description_type: "text"
    });

    const rapidApiUrl = `https://active-jobs-db.p.rapidapi.com/active-ats-7d?${params}`;

    const apiResponse = await fetch(rapidApiUrl, {
      headers: {
        "x-rapidapi-key": process.env.RAPIDAPI_KEY,
        "x-rapidapi-host": "active-jobs-db.p.rapidapi.com"
      }
    });

    const responseText = await apiResponse.text();
    if (responseText.trim().startsWith("<!DOCTYPE html>")) {
      console.error("Received HTML error from gateway:", responseText.slice(0, 200));
      throw new Error("Job provider temporarily unavailable");
    }

    const data = JSON.parse(responseText);
    res.status(200).json(data);

  } catch (error) {
    console.error("Jobs route error:", error);
    res.status(500).json({ 
      error: error.message || "Failed to fetch jobs",
      ...(process.env.NODE_ENV === "development" && { debug: error.stack })
    });
  }
});

module.exports = router;
