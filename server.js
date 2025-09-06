// backend/server.js - Fixed to use better-sqlite3 properly
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// SQLite database using better-sqlite3
const db = new Database('./bus_data.db');

// Create tables - better-sqlite3 syntax
db.exec(`CREATE TABLE IF NOT EXISTS bus_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bus_id TEXT NOT NULL,
  route_number TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
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

// Cache
let busDataCache = {
  data: null,
  lastUpdated: null,
  cacheExpiry: 30000
};

// Fetch Metrobus data
async function fetchMetrobusData() {
  try {
    console.log('[FETCH] Requesting Metrobus API...');
    const response = await axios.get('https://www.metrobusmobile.com/apilive/timetrack/json/', {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BusTracker/1.0)',
        'Referer': 'https://www.metrobusmobile.com/',
        'Accept': 'application/json'
      }
    });

    console.log('[FETCH] API Response Status:', response.status);
    console.log('[FETCH] Response type:', Array.isArray(response.data) ? 'Array' : 'Object');
    console.log('[FETCH] Response keys/length:', Array.isArray(response.data) ? response.data.length : Object.keys(response.data));

    // Handle both possible response formats
    let buses;
    if (Array.isArray(response.data)) {
      // Direct array response
      buses = response.data;
      console.log('[FETCH] Using direct array response');
    } else if (response.data?.Bus && Array.isArray(response.data.Bus)) {
      // Object with Bus property
      buses = response.data.Bus;
      console.log('[FETCH] Using Bus property from response');
    } else {
      console.error('[FETCH] Unexpected response format. Type:', typeof response.data);
      console.error('[FETCH] Sample data:', JSON.stringify(response.data).substring(0, 500));
      return [];
    }

    if (!Array.isArray(buses)) {
      console.error('[FETCH] Buses is not an array:', typeof buses);
      return [];
    }

    if (buses.length === 0) {
      console.log('[FETCH] No active buses returned');
      return [];
    }

    console.log(`[FETCH] Found ${buses.length} buses in API response`);
    console.log('[FETCH] Sample bus data:', JSON.stringify(buses[0], null, 2));

    // Clear old data (keep last hour for debugging) - better-sqlite3 syntax
    db.prepare(`DELETE FROM bus_positions WHERE timestamp < datetime('now', '-10 minutes')`).run();

    const stmt = db.prepare(`INSERT INTO bus_positions 
      (bus_id, route_number, latitude, longitude, heading, speed, current_location, deviation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    let insertedCount = 0;
    buses.forEach(bus => {
      // Use correct field names from your API response
      const lat = parseFloat(bus.bus_lat);
      const lng = parseFloat(bus.bus_lon);
      
      // Skip buses without valid coordinates
      if (isNaN(lat) || isNaN(lng)) {
        console.log(`[SKIP] Bus ${bus.vehicle} - invalid coordinates: lat=${bus.bus_lat}, lng=${bus.bus_lon}`);
        return;
      }

      const busId = bus.vehicle || `bus_${Date.now()}`;
      const route = bus.routenumber || bus.current_route || 'Unknown';
      const heading = bus.heading || 'Unknown';
      const speed = parseFloat(bus.speed) || 0;
      const location = bus.current_location || 'Unknown';
      const deviation = bus.deviation || 'On time';

      try {
        stmt.run(busId, route, lat, lng, heading, speed, location, deviation);
        console.log(`[INSERT] ${busId} | Route: ${route} | ${lat}, ${lng} | Speed: ${speed} | ${location}`);
        insertedCount++;
      } catch (err) {
        console.error(`[ERROR] Failed to insert bus ${busId}:`, err.message);
      }
    });

    // Transform data for cache (keep original API format for frontend compatibility)
    const transformedBuses = buses.map(bus => ({
      // Keep original fields
      ...bus,
      // Add standardized fields for frontend
      veh: bus.vehicle,
      route: bus.routenumber,
      lat: parseFloat(bus.bus_lat),
      lng: parseFloat(bus.bus_lon),
      hdg: bus.heading,
      spd: parseFloat(bus.speed) || 0
    }));

    busDataCache = {
      data: transformedBuses,
      lastUpdated: new Date(),
      cacheExpiry: 30000
    };

    console.log(`[FETCH] Successfully stored ${insertedCount}/${buses.length} buses at ${busDataCache.lastUpdated.toISOString()}`);
    return transformedBuses;

  } catch (error) {
    console.error('[ERROR] Failed to fetch data:', error.message);
    console.error('[ERROR] Full error:', error);

    if (busDataCache.data) {
      console.log('[CACHE] Returning stale cached data');
      return busDataCache.data;
    }

    throw error;
  }
}

// Routes

app.get('/api/buses', async (req, res) => {
  try {
    const now = new Date();
    const age = busDataCache.lastUpdated ? now - busDataCache.lastUpdated : Infinity;

    if (busDataCache.data && age < busDataCache.cacheExpiry) {
      console.log(`[CACHE] Returning recent bus data (${busDataCache.data.length} buses, age: ${Math.round(age/1000)}s)`);
      return res.json({
        success: true,
        data: busDataCache.data,
        cached: true,
        lastUpdated: busDataCache.lastUpdated,
        count: busDataCache.data.length
      });
    }

    console.log('[API] Fetching fresh bus data...');
    const data = await fetchMetrobusData();
    res.json({
      success: true,
      data,
      cached: false,
      lastUpdated: busDataCache.lastUpdated,
      count: data.length
    });

  } catch (error) {
    console.error('[ERROR] Main buses endpoint failed:', error);
    
    // Fallback to database - better-sqlite3 syntax
    try {
      const rows = db.prepare(`SELECT * FROM bus_positions 
              WHERE timestamp > datetime('now', '-5 minutes')
              ORDER BY timestamp DESC`).all();

      console.log(`[FALLBACK] Returning ${rows.length} buses from database`);
      res.json({
        success: true,
        data: rows,
        cached: true,
        fallback: true,
        count: rows.length,
        message: 'Using recent data from database'
      });
    } catch (dbError) {
      console.error('[ERROR] Database fallback failed:', dbError);
      return res.status(500).json({
        success: false,
        error: 'Database error',
        message: dbError.message
      });
    }
  }
});

app.get('/api/buses/filtered', async (req, res) => {
  try {
    const { routes, busNumber } = req.query;
    console.log(`[FILTER] Routes: ${routes}, Bus: ${busNumber}`);
    
    let query = `SELECT * FROM bus_positions 
                 WHERE timestamp > datetime('now', '-5 minutes')`;
    let params = [];

    if (routes) {
      const routeList = routes.split(',').map(r => r.trim());
      const placeholders = routeList.map(() => '?').join(',');
      query += ` AND route_number IN (${placeholders})`;
      params.push(...routeList);
    }

    if (busNumber) {
      query += ` AND bus_id LIKE ?`;
      params.push(`%${busNumber}%`);
    }

    query += ` ORDER BY timestamp DESC`;

    const rows = db.prepare(query).all(...params);

    console.log(`[FILTER] Found ${rows.length} buses matching filters`);
    res.json({
      success: true,
      data: rows,
      filters: { routes, busNumber },
      count: rows.length
    });

  } catch (error) {
    console.error('[ERROR] Filtered endpoint failed:', error);
    res.status(500).json({
      success: false,
      error: 'Filtered fetch failed',
      message: error.message
    });
  }
});

app.get('/api/routes', (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM routes ORDER BY route_short_name`).all();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Routes fetch failed',
      message: error.message
    });
  }
});

app.get('/api/stops', (req, res) => {
  try {
    const { limit } = req.query;
    let query = `SELECT * FROM stops ORDER BY stop_name`;
    
    let rows;
    if (limit) {
      rows = db.prepare(query + ` LIMIT ?`).all(parseInt(limit));
    } else {
      rows = db.prepare(query).all();
    }

    res.json({
      success: true,
      data: rows,
      count: rows.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Stops fetch failed',
      message: error.message
    });
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
      age: busDataCache.lastUpdated ? new Date() - busDataCache.lastUpdated : null,
      count: busDataCache.data ? busDataCache.data.length : 0
    }
  });
});

// Debug endpoint to test Metrobus API directly
app.get('/api/test-metrobus', async (req, res) => {
  try {
    console.log('[TEST] Testing direct Metrobus API access...');
    const data = await fetchMetrobusData();
    res.json({
      success: true,
      rawData: data,
      count: data.length,
      sample: data[0], // First bus for inspection
      message: 'Direct API test successful'
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message,
      message: 'Direct API test failed'
    });
  }
});

// Debug endpoint to check database contents
app.get('/api/debug/database', (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM bus_positions ORDER BY timestamp DESC LIMIT 10`).all();
    const countResult = db.prepare(`SELECT COUNT(*) as total FROM bus_positions`).get();
    
    res.json({
      success: true,
      recentBuses: rows,
      totalInDatabase: countResult ? countResult.total : 0,
      message: 'Database contents'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Fetch every 30 seconds
const startPeriodicFetch = () => {
  console.log('Starting periodic bus data fetching...');
  fetchMetrobusData().catch(console.error);
  setInterval(() => {
    console.log('[PERIODIC] Fetching bus data...');
    fetchMetrobusData().catch(console.error);
  }, 30000);
};

app.listen(PORT, () => {
  console.log(`Bus Tracker API server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Test Metrobus API: http://localhost:${PORT}/api/test-metrobus`);
  console.log(`Debug database: http://localhost:${PORT}/api/debug/database`);
  startPeriodicFetch();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  db.close();
  console.log('Database closed.');
  process.exit(0);
});
