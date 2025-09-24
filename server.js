// backend/server.js - Rewritten to return a flat list of bus dictionaries (with route simplified)
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const db = new Database('./bus_data.db');

db.exec(`CREATE TABLE IF NOT EXISTS bus_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bus_id TEXT NOT NULL,
  route_number TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  heading TEXT,
  speed REAL,
  current_location TEXT,
  deviation TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS routes (
  route_id TEXT PRIMARY KEY,
  route_short_name TEXT NOT NULL,
  route_long_name TEXT,
  route_color TEXT,
  route_text_color TEXT
)`);

db.exec(`CREATE TABLE IF NOT EXISTS stops (
  stop_id TEXT PRIMARY KEY,
  stop_code TEXT,
  stop_name TEXT NOT NULL,
  stop_lat REAL NOT NULL,
  stop_lon REAL NOT NULL,
  wheelchair_boarding INTEGER DEFAULT 0
)`);

let busDataCache = {
  data: null,
  lastUpdated: null,
  cacheExpiry: 30000
};

async function fetchMetrobusData() {
  try {
    console.log('[FETCH] Requesting Metrobus API...');
    const response = await axios.get('https://www.metrobus.com/avl/GEOjson/', {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BusTracker/1.0)',
        'Referer': 'https://www.metrobusmobile.com/',
        'Accept': 'application/json'
      }
    });

    let buses = [];
    if (Array.isArray(response.data)) {
      buses = response.data;
    } else if (response.data?.Bus && Array.isArray(response.data.Bus)) {
      buses = response.data.Bus;
    } else {
      console.error('[FETCH] Unexpected response format:', typeof response.data);
      return [];
    }

    if (!buses.length) {
      console.log('[FETCH] No active buses returned');
      return [];
    }

    console.log(`[FETCH] Found ${buses.length} buses`);

    db.prepare(`DELETE FROM bus_positions WHERE timestamp < datetime('now', '-10 minutes')`).run();

    const stmt = db.prepare(`INSERT INTO bus_positions 
      (bus_id, route_number, latitude, longitude, heading, speed, current_location, deviation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    const transformedBuses = buses.map(bus => {
      let lat = null, lng = null;
      if (bus.geometry && Array.isArray(bus.geometry.coordinates)) {
        lng = parseFloat(bus.geometry.coordinates[0]);
        lat = parseFloat(bus.geometry.coordinates[1]);
      }

      // Simplify route number (remove - and following)
      let routeRaw = bus.properties?.name || '';
      let routeNumber = routeRaw.split('-')[0];

      try {
        if (lat !== null && lng !== null) {
          stmt.run(
            bus.properties?.id || 'unknown',
            routeNumber,
            lat,
            lng,
            bus.properties?.direction || 'Unknown',
            parseFloat(bus.properties?.speed) || 0,
            bus.properties?.location || 'Unknown',
            bus.properties?.status || 'On time'
          );
        }
      } catch (err) {
        console.error('[ERROR] Failed DB insert:', err.message);
      }

      return {
        id: bus.properties?.id || null,
        route: routeNumber,
        unit: bus.properties?.unit || null,
        lat,
        lng,
        direction: bus.properties?.direction || null,
        speed: parseFloat(bus.properties?.speed) || 0,
        status: bus.properties?.status || null,
        location: bus.properties?.location || null,
        line: bus.properties?.line || null,
        icon: bus.properties?.icon || null,
        popupContent: bus.properties?.popupContent || null,
        timestamp: new Date().toISOString()
      };
    });

    busDataCache = {
      data: transformedBuses,
      lastUpdated: new Date(),
      cacheExpiry: 30000
    };

    console.log(`[FETCH] Stored ${transformedBuses.length} buses in cache`);
    return transformedBuses;

  } catch (error) {
    console.error('[ERROR] Failed to fetch data:', error.message);
    if (busDataCache.data) {
      console.log('[CACHE] Returning stale cached data');
      return busDataCache.data;
    }
    throw error;
  }
}

app.get('/api/buses', async (req, res) => {
  try {
    const now = new Date();
    const age = busDataCache.lastUpdated ? now - busDataCache.lastUpdated : Infinity;

    if (busDataCache.data && age < busDataCache.cacheExpiry) {
      return res.json({
        success: true,
        data: busDataCache.data,
        cached: true,
        lastUpdated: busDataCache.lastUpdated,
        count: busDataCache.data.length
      });
    }

    const data = await fetchMetrobusData();
    res.json({
      success: true,
      data,
      cached: false,
      lastUpdated: busDataCache.lastUpdated,
      count: data.length
    });
  } catch (error) {
    console.error('[ERROR] /api/buses failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/buses/filtered', (req, res) => {
  try {
    const { routes, busNumber } = req.query;
    let query = `SELECT * FROM bus_positions WHERE timestamp > datetime('now', '-5 minutes')`;
    let params = [];

    if (routes) {
      const routeList = routes.split(',').map(r => r.trim());
      query += ` AND route_number IN (${routeList.map(() => '?').join(',')})`;
      params.push(...routeList);
    }

    if (busNumber) {
      query += ` AND bus_id LIKE ?`;
      params.push(`%${busNumber}%`);
    }

    const rows = db.prepare(query).all(...params);
    res.json({ success: true, data: rows, count: rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/routes', (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM routes ORDER BY route_short_name`).all();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/stops', (req, res) => {
  try {
    const { limit } = req.query;
    let query = `SELECT * FROM stops ORDER BY stop_name`;
    let rows = limit ? db.prepare(query + ` LIMIT ?`).all(parseInt(limit)) : db.prepare(query).all();
    res.json({ success: true, data: rows, count: rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'OK',
    timestamp: new Date(),
    cache: {
      hasData: !!busDataCache.data,
      lastUpdated: busDataCache.lastUpdated,
      count: busDataCache.data ? busDataCache.data.length : 0
    }
  });
});

app.get('/api/test-metrobus', async (req, res) => {
  try {
    const data = await fetchMetrobusData();
    res.json({ success: true, data, count: data.length });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/debug/database', (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM bus_positions ORDER BY timestamp DESC LIMIT 10`).all();
    const countResult = db.prepare(`SELECT COUNT(*) as total FROM bus_positions`).get();
    res.json({ success: true, recentBuses: rows, total: countResult.total });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const startPeriodicFetch = () => {
  console.log('Starting periodic bus data fetching...');
  fetchMetrobusData().catch(console.error);
  setInterval(fetchMetrobusData, 30000);
};

app.listen(PORT, () => {
  console.log(`Bus Tracker API server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  startPeriodicFetch();
});

process.on('SIGINT', () => {
  console.log('Shutting down server...');
  db.close();
  process.exit(0);
});
