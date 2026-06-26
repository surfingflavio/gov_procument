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
        const result = await syncTenders(env.DB, env);
        
        return new Response(JSON.stringify(result), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          },
        });
      }

      // Temp API: Test sending email
      if (url.pathname === '/api/test-email') {
        const apiKey = env.RESEND_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "RESEND_API_KEY is not configured. Please use 'wrangler secret put RESEND_API_KEY' to set it." }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const queryTo = url.searchParams.get('to');
        const targetEmail = queryTo || 'flaviochang@gamania.com';

        const fromEmail = env.FROM_EMAIL || 'onboarding@resend.dev';
        const fromName = '雲力橘子_招標資訊分析系統';

        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: `${fromName} <${fromEmail}>`,
            to: [targetEmail],
            subject: '專案進度週報',
            html: '您好，目前系統的 GitHub 自動化部署已經測試完畢，功能一切正常。'
          })
        });

        if (!res.ok) {
          const errText = await res.text();
          return new Response(JSON.stringify({ error: `Resend error: ${errText}` }), {
            status: res.status,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 4. API: Recipients CRUD
      if (url.pathname === '/api/recipients') {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "Database binding DB not found" }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        if (request.method === 'GET') {
          const { results } = await env.DB.prepare(
            "SELECT * FROM recipients ORDER BY created_at DESC"
          ).all();
          return new Response(JSON.stringify(results), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        if (request.method === 'POST') {
          try {
            const body = await request.json();
            const { name, email } = body;
            if (!name || !email) {
              return new Response(JSON.stringify({ error: "姓名與電子郵件為必填欄位" }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
              });
            }
            if (!email.includes('@')) {
              return new Response(JSON.stringify({ error: "電子郵件格式不正確" }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
              });
            }

            await env.DB.prepare(
              "INSERT INTO recipients (name, email) VALUES (?, ?)"
            ).bind(name.trim(), email.trim().toLowerCase()).run();

            return new Response(JSON.stringify({ success: true }), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          } catch (dbErr) {
            if (dbErr.message && dbErr.message.includes('UNIQUE')) {
              return new Response(JSON.stringify({ error: "此電子郵件已存在，請使用其他郵件" }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
              });
            }
            throw dbErr;
          }
        }
      }

      if (url.pathname.startsWith('/api/recipients/')) {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "Database binding DB not found" }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const parts = url.pathname.split('/');
        const id = parseInt(parts[parts.length - 1]);
        if (isNaN(id)) {
          return new Response(JSON.stringify({ error: "無效的 ID" }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        if (request.method === 'PUT') {
          try {
            const body = await request.json();
            const { name, email } = body;
            if (!name || !email) {
              return new Response(JSON.stringify({ error: "姓名與電子郵件為必填欄位" }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
              });
            }
            if (!email.includes('@')) {
              return new Response(JSON.stringify({ error: "電子郵件格式不正確" }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
              });
            }

            await env.DB.prepare(
              "UPDATE recipients SET name = ?, email = ? WHERE id = ?"
            ).bind(name.trim(), email.trim().toLowerCase(), id).run();

            return new Response(JSON.stringify({ success: true }), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          } catch (dbErr) {
            if (dbErr.message && dbErr.message.includes('UNIQUE')) {
              return new Response(JSON.stringify({ error: "此電子郵件已存在，請使用其他郵件" }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
              });
            }
            throw dbErr;
          }
        }

        if (request.method === 'DELETE') {
          await env.DB.prepare(
            "DELETE FROM recipients WHERE id = ?"
          ).bind(id).run();

          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
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
    ctx.waitUntil(syncTenders(env.DB, env));
  }
};
