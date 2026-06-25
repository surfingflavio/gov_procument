// src/index.js
import htmlContent from './views/dashboard.html';
import { syncTenders } from './scraper.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS Headers for API endpoints
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Router
    try {
      // 1. Frontend Homepage UI
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(htmlContent, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
          },
        });
      }

      // 2. API: Get all tenders from D1 Database
      if (url.pathname === '/api/tenders') {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "Database binding DB not found" }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        
        const { results } = await env.DB.prepare(
          "SELECT * FROM tenders ORDER BY publish_date DESC"
        ).all();
        
        return new Response(JSON.stringify(results), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          },
        });
      }

      // 3. API: Trigger scraping sync manually
      if (url.pathname === '/api/sync' && request.method === 'POST') {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "Database binding DB not found" }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        console.log("Manual sync triggered via POST /api/sync");
        // Run sync process
        const result = await syncTenders(env.DB);
        
        return new Response(JSON.stringify(result), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          },
        });
      }

      // 404 Not Found
      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error("Worker error handler caught:", err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  },

  // Automated Daily Cron Trigger handler
  async scheduled(event, env, ctx) {
    console.log(`Cron sync trigger running at: ${new Date().toISOString()}`);
    if (!env.DB) {
      console.error("Database binding DB not found during cron trigger");
      return;
    }
    
    // We run the scraper asynchronously under Workers execution context
    ctx.waitUntil(syncTenders(env.DB));
  }
};
