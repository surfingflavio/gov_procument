// src/index.js (admin console active)
import htmlContent from './views/dashboard.html';
import adminHtmlContent from './views/admin.html';
import { syncTenders, buildNotificationEmail } from './scraper.js';
import { WorkerMailer } from 'worker-mailer';


// Web Crypto Session Helpers
const fallbackSecret = "dgc-procu-secret-key-111111";

async function signToken(payload, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret || fallbackSecret);
  const key = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const base64Sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return btoa(payload).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') + '.' + base64Sig;
}

async function verifyToken(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    
    // Decode base64url to base64
    const base64Payload = parts[0].replace(/-/g, '+').replace(/_/g, '/');
    const payload = atob(base64Payload);
    const signatureStr = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret || fallbackSecret);
    const key = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    
    const sigBinary = atob(signatureStr);
    const sigBytes = new Uint8Array(sigBinary.length);
    for (let i = 0; i < sigBinary.length; i++) {
      sigBytes[i] = sigBinary.charCodeAt(i);
    }
    
    const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(payload));
    if (!isValid) return null;
    
    const data = JSON.parse(payload);
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch (e) {
    return null;
  }
}

// Cookie Helper
function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';');
  for (let cookie of cookies) {
    const [key, val] = cookie.trim().split('=');
    if (key === name) return val;
  }
  return null;
}

// Authentication check middleware
async function getCurrentUser(request, env) {
  const token = getCookie(request, 'session');
  if (!token) return null;
  return await verifyToken(token, env.JWT_SECRET);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS Headers for API endpoints
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
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

      // 1b. Frontend Admin UI
      if (url.pathname === '/admin' || url.pathname === '/admin.html') {
        return new Response(adminHtmlContent, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
          },
        });
      }

      // ==========================================
      // AUTHENTICATION CHECKS FOR MAIN APPLICATION APIS
      // ==========================================
      if (url.pathname.startsWith('/api/') && 
          url.pathname !== '/api/auth/login' && 
          url.pathname !== '/api/auth/logout' && 
          url.pathname !== '/api/auth/me') {
        const currentUser = await getCurrentUser(request, env);
        if (!currentUser) {
          return new Response(JSON.stringify({ error: "未登入，請先登入系統" }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
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

        // Verify admin role
        const currentUser = await getCurrentUser(request, env);
        if (!currentUser || currentUser.role !== 'admin') {
          return new Response(JSON.stringify({ error: "權限不足，必須是管理者才能更新" }), {
            status: 401,
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
        if (!env.GMAIL_PASS) {
          return new Response(JSON.stringify({ error: "GMAIL_PASS is not configured. Please add it to your .dev.vars file or use 'wrangler secret put GMAIL_PASS' to set it." }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        if (!env.DB) {
          return new Response(JSON.stringify({ error: "Database binding DB not found" }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Query all users who receive notifications
        const { results: dbRecipients } = await env.DB.prepare(
          "SELECT username AS name, email FROM users WHERE receive_notifications = 1"
        ).all();

        const queryTo = url.searchParams.get('to');
        let toList = [];
        if (queryTo) {
          toList = [{ name: '測試收件人', email: queryTo }];
        } else if (dbRecipients && dbRecipients.length > 0) {
          toList = dbRecipients.map(r => ({ name: r.name || '', email: r.email }));
        } else {
          toList = [{ name: 'Flavio', email: 'flaviochang@gamania.com' }];
        }

        const fromEmail = 'surfingflavio@gmail.com';
        const fromName = '雲力橘子_招標資訊分析系統';

        // Query the latest 5 tenders from database to serve as test payload
        const { results: recentTenders } = await env.DB.prepare(
          "SELECT * FROM tenders ORDER BY publish_date DESC LIMIT 5"
        ).all();

        try {
          const mailer = await WorkerMailer.connect({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            authType: 'login',
            credentials: {
              username: fromEmail,
              password: env.GMAIL_PASS
            }
          });

          for (const r of toList) {
            const greetName = r.name ? r.name.trim() : r.email.split('@')[0];
            const { subject, htmlBody } = buildNotificationEmail(recentTenders || [], greetName);

            await mailer.send({
              from: { name: fromName, email: fromEmail },
              to: [r],
              subject: subject,
              html: htmlBody
            });
          }

          return new Response(JSON.stringify({ success: true, recipients: toList }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (mailErr) {
          return new Response(JSON.stringify({ error: `Gmail SMTP error: ${mailErr.message || mailErr}` }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
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

      // 5. API: Update Tender details (pin, remove, edit, notes)
      if (url.pathname === '/api/tenders/update' && request.method === 'POST') {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "Database binding DB not found" }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const body = await request.json();
        const { uids, case_number, publish_date, end_date, budget, budget_text, urls, is_pinned, is_locked, is_removed, notes } = body;

        if (!uids || !Array.isArray(uids) || uids.length === 0) {
          return new Response(JSON.stringify({ error: "Missing uids" }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const statements = [];

        for (const uid of uids) {
          const updates = [];
          const values = [];

          if (case_number !== undefined) {
            updates.push("case_number = ?");
            values.push(case_number);
          }
          if (publish_date !== undefined) {
            updates.push("publish_date = ?");
            values.push(publish_date);
          }
          if (end_date !== undefined) {
            updates.push("end_date = ?");
            values.push(end_date);
          }
          if (budget !== undefined) {
            updates.push("budget = ?");
            values.push(budget);
            updates.push("budget_text = ?");
            values.push(budget_text || (budget > 0 ? budget.toLocaleString('zh-TW') + "元" : "未公開或未填"));
          }
          if (urls && urls[uid] !== undefined) {
            updates.push("url = ?");
            values.push(urls[uid]);
          }
          if (is_pinned !== undefined) {
            updates.push("is_pinned = ?");
            values.push(is_pinned);
          }
          if (is_locked !== undefined) {
            updates.push("is_locked = ?");
            values.push(is_locked);
          }
          if (is_removed !== undefined) {
            updates.push("is_removed = ?");
            values.push(is_removed);
          }
          if (notes !== undefined) {
            updates.push("notes = ?");
            values.push(notes);
          }

          const detailsEdited = (case_number !== undefined || publish_date !== undefined || end_date !== undefined || budget !== undefined || (urls && urls[uid] !== undefined));
          if (detailsEdited) {
            updates.push("is_edited = 1");
          }

          if (updates.length > 0) {
            values.push(uid);
            statements.push(
              env.DB.prepare(`UPDATE tenders SET ${updates.join(', ')} WHERE uid = ?`).bind(...values)
            );
          }
        }

        if (statements.length > 0) {
          await env.DB.batch(statements);
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // ==========================================
      // AUTHENTICATION & USER MANAGEMENT API
      // ==========================================

      // 6. POST /api/auth/login
      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "Database binding DB not found" }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const { email, password } = await request.json();
        if (!email || !password) {
          return new Response(JSON.stringify({ error: "請輸入帳號與密碼" }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Query database for user
        const user = await env.DB.prepare(
          "SELECT * FROM users WHERE email = ?"
        ).bind(email.trim().toLowerCase()).first();

        if (!user || user.password !== password) {
          return new Response(JSON.stringify({ error: "帳號或密碼錯誤" }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Generate session token
        const payload = JSON.stringify({
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
          exp: Date.now() + 24 * 60 * 60 * 1000 // 1 day
        });

        const token = await signToken(payload, env.JWT_SECRET);

        return new Response(JSON.stringify({
          success: true,
          user: { email: user.email, username: user.username, role: user.role }
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`,
            ...corsHeaders
          }
        });
      }

      // 7. POST /api/auth/logout
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
            ...corsHeaders
          }
        });
      }

      // 8. GET /api/auth/me
      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        const user = await getCurrentUser(request, env);
        if (!user) {
          return new Response(JSON.stringify({ authenticated: false }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        return new Response(JSON.stringify({
          authenticated: true,
          user: { email: user.email, username: user.username, role: user.role }
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 9. GET /api/users (Admin only)
      if (url.pathname === '/api/users' && request.method === 'GET') {
        const currentUser = await getCurrentUser(request, env);
        if (!currentUser || currentUser.role !== 'admin') {
          return new Response(JSON.stringify({ error: "權限不足，必須是管理者" }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const { results } = await env.DB.prepare(
          "SELECT id, email, username, role, receive_notifications, created_at FROM users ORDER BY id ASC"
        ).all();

        return new Response(JSON.stringify(results), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 10. POST /api/users (Admin only)
      if (url.pathname === '/api/users' && request.method === 'POST') {
        const currentUser = await getCurrentUser(request, env);
        if (!currentUser || currentUser.role !== 'admin') {
          return new Response(JSON.stringify({ error: "權限不足，必須是管理者" }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const { email, username, password, role, receive_notifications } = await request.json();
        if (!email || !username || !password || !role) {
          return new Response(JSON.stringify({ error: "所有欄位皆為必填項目" }), {
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

        const receive_notif = (receive_notifications === undefined || receive_notifications === null) ? 1 : (receive_notifications ? 1 : 0);

        try {
          await env.DB.prepare(
            "INSERT INTO users (email, username, password, role, receive_notifications) VALUES (?, ?, ?, ?, ?)"
          ).bind(email.trim().toLowerCase(), username.trim(), password, role, receive_notif).run();

          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (dbErr) {
          if (dbErr.message && dbErr.message.includes('UNIQUE')) {
            return new Response(JSON.stringify({ error: "該電子郵件已被註冊" }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          throw dbErr;
        }
      }

      // 11. PUT /api/users/:id (Admin only)
      if (url.pathname.startsWith('/api/users/') && request.method === 'PUT') {
        const currentUser = await getCurrentUser(request, env);
        if (!currentUser || currentUser.role !== 'admin') {
          return new Response(JSON.stringify({ error: "權限不足，必須是管理者" }), {
            status: 401,
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

        const { email, username, password, role, receive_notifications } = await request.json();
        if (!email || !username || !role) {
          return new Response(JSON.stringify({ error: "電子郵件、使用者名稱與權限為必填項目" }), {
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

        const receive_notif = (receive_notifications === undefined || receive_notifications === null) ? 1 : (receive_notifications ? 1 : 0);

        try {
          if (password && password.trim() !== '') {
            // Update including password
            await env.DB.prepare(
              "UPDATE users SET email = ?, username = ?, password = ?, role = ?, receive_notifications = ? WHERE id = ?"
            ).bind(email.trim().toLowerCase(), username.trim(), password, role, receive_notif, id).run();
          } else {
            // Update without changing password
            await env.DB.prepare(
              "UPDATE users SET email = ?, username = ?, role = ?, receive_notifications = ? WHERE id = ?"
            ).bind(email.trim().toLowerCase(), username.trim(), role, receive_notif, id).run();
          }

          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (dbErr) {
          if (dbErr.message && dbErr.message.includes('UNIQUE')) {
            return new Response(JSON.stringify({ error: "該電子郵件已被其他使用者註冊" }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          throw dbErr;
        }
      }

      // 12. DELETE /api/users/:id (Admin only)
      if (url.pathname.startsWith('/api/users/') && request.method === 'DELETE') {
        const currentUser = await getCurrentUser(request, env);
        if (!currentUser || currentUser.role !== 'admin') {
          return new Response(JSON.stringify({ error: "權限不足，必須是管理者" }), {
            status: 401,
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

        // Query the user to delete to check email
        const userToDelete = await env.DB.prepare(
          "SELECT email FROM users WHERE id = ?"
        ).bind(id).first();

        if (!userToDelete) {
          return new Response(JSON.stringify({ error: "找不到該使用者" }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        if (userToDelete.email === currentUser.email) {
          return new Response(JSON.stringify({ error: "無法刪除自己目前登入的帳號" }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        await env.DB.prepare(
          "DELETE FROM users WHERE id = ?"
        ).bind(id).run();

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
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
    ctx.waitUntil(syncTenders(env.DB, env));
  }
};
