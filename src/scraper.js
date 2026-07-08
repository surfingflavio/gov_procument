// src/scraper.js
import { WorkerMailer } from 'worker-mailer';


// Regular expression to parse list items from acebidx search page
// Matches the structure of list items on acebidx
const ACEBIDX_TENDER_REGEX = /<li[^>]*value="[^"]*".*?href="([^"]+)"[^>]*>.*?group-hover:underline[^>]*>([\s\S]*?)<\/span>.*?truncate[^>]*>([\s\S]*?)<\/span>.*?whitespace-nowrap[^>]*>([\s\S]*?)<\/span>/gi;

// Clean text by removing HTML comments, spaces, and formatting characters
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/<!--[\s\S]*?-->/g, "") // remove HTML comments
    .replace(/\s+/g, " ")            // normalize spaces
    .trim();
}

// Convert Taiwanese dates like "6月24日" to standard YYYY-MM-DD format
function parseTaiwanDate(dateStr) {
  dateStr = cleanText(dateStr).replace(/公告/g, "").trim();
  
  // Current local date/year context
  const currentYear = new Date().getFullYear();
  
  // Match "M月D日" or "YYYY-MM-DD"
  const mdMatch = dateStr.match(/(\d+)\s*月\s*(\d+)\s*日/);
  if (mdMatch) {
    const month = mdMatch[1].padStart(2, '0');
    const day = mdMatch[2].padStart(2, '0');
    return `${currentYear}-${month}-${day}`;
  }
  
  const ymdMatch = dateStr.match(/(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/);
  if (ymdMatch) {
    const year = ymdMatch[1];
    const month = ymdMatch[2].padStart(2, '0');
    const day = ymdMatch[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  // ROC date "民國115年6月24日" or "115/06/24"
  const rocMatch = dateStr.match(/(?:民國)?\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
  if (rocMatch) {
    const year = parseInt(rocMatch[1], 10) + 1911;
    const month = rocMatch[2].padStart(2, '0');
    const day = rocMatch[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  const rocSlashMatch = dateStr.match(/^(\d{2,3})[-\/\.](\d{1,2})[-\/\.](\d{1,2})$/);
  if (rocSlashMatch) {
    const year = parseInt(rocSlashMatch[1], 10) + 1911;
    const month = rocSlashMatch[2].padStart(2, '0');
    const day = rocSlashMatch[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  return dateStr; // fallback to original string
}

// Extract budget amount from detail page HTML
function extractBudget(html) {
  const idx = html.indexOf('預算金額');
  if (idx !== -1) {
    const sub = html.substring(idx, idx + 2000);
    // Matches React component serialization children pattern for budget amount
    const match = sub.match(/span\\?",(?:null,)?\{[^\}]+?\\?"children\\?":\[\\?"([^"]+?)\\?"/);
    if (match) {
      const budgetStr = match[1].replace(/,/g, '').replace(/元/g, '').trim();
      const budgetVal = parseInt(budgetStr, 10);
      if (!isNaN(budgetVal)) {
        return {
          budget: budgetVal,
          text: budgetVal.toLocaleString('zh-TW') + "元"
        };
      }
    }
    
    // Fallback: look for generic currency numbers in proximity
    const m = sub.match(/([\d,]+)\s*(?:元)?/);
    if (m) {
      const budgetVal = parseInt(m[1].replace(/,/g, ''), 10);
      if (!isNaN(budgetVal) && budgetVal > 0) {
        return {
          budget: budgetVal,
          text: budgetVal.toLocaleString('zh-TW') + "元"
        };
      }
    }
  }
  
  // Default fallback if not found or unannounced
  return { budget: 0, text: "未公開或未填" };
}

// Extract bidding case number from detail page HTML
function extractCaseNumber(html) {
  const match = html.match(/案號：\s*([^|&<"\s]+)/);
  if (match) {
    return match[1].trim();
  }
  return "";
}

// Extract bidding deadline date from detail page HTML and normalize to YYYY-MM-DD HH:mm
function extractEndDate(html) {
  const idx = html.indexOf('截止投標');
  if (idx !== -1) {
    const sub = html.substring(idx, idx + 2000);
    const match = sub.match(/(\d{2,4})[\/\.-](\d{1,2})[\/\.-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?/);
    if (match) {
      const year = match[1];
      const month = match[2].padStart(2, '0');
      const day = match[3].padStart(2, '0');
      const time = match[4] && match[5] ? ` ${match[4].padStart(2, '0')}:${match[5].padStart(2, '0')}` : '';
      
      let gYear = parseInt(year, 10);
      if (gYear < 1000) {
        gYear += 1911;
      }
      return `${gYear}-${month}-${day}${time}`;
    }
  }
  return "";
}

// Scrape tenders from acebidx.com
async function scrapeAcebidx(keyword) {
  const tenders = [];
  const url = `https://acebidx.com/zh-TW/docs/tender/T/by-keyword/${encodeURIComponent(keyword)}`;
  
  console.log(`Scraping acebidx.com for keyword: "${keyword}"...`);
  
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    
    if (!response.ok) {
      console.error(`Acebidx returned status ${response.status}`);
      return [];
    }
    
    const html = await response.text();
    let match;
    const matches = [];
    
    // Find all matches first
    ACEBIDX_TENDER_REGEX.lastIndex = 0;
    while ((match = ACEBIDX_TENDER_REGEX.exec(html)) !== null) {
      matches.push({
        path: match[1],
        title: cleanText(match[2]),
        agency: cleanText(match[3]),
        dateText: cleanText(match[4])
      });
    }
    
    console.log(`Found ${matches.length} matches on acebidx list for "${keyword}"`);
    
    // Fetch details for first 15 biddings to prevent Cloudflare/Workers CPU time limits
    // Typically 60-day recent bids are at the top, so 15 is plenty for a keyword sync
    const listToFetch = matches.slice(0, 15);
    
    for (const item of listToFetch) {
      const detailUrl = `https://acebidx.com${item.path}`;
      const uid = `acebidx_${item.path.split('/').pop()}`;
      
      let budget = 0;
      let budgetText = "未公開或未填";
      let caseNumber = "";
      let endDate = "";
      
      try {
        // Fetch specific details
        const detailResponse = await fetch(detailUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          }
        });
        if (detailResponse.ok) {
          const detailHtml = await detailResponse.text();
          const parsedBudget = extractBudget(detailHtml);
          budget = parsedBudget.budget;
          budgetText = parsedBudget.text;
          caseNumber = extractCaseNumber(detailHtml);
          endDate = extractEndDate(detailHtml);
        }
      } catch (err) {
        console.error(`Error fetching detail page ${detailUrl}:`, err.message);
      }
      
      tenders.push({
        uid,
        source: "acebidx",
        case_number: caseNumber,
        agency: item.agency,
        title: item.title,
        publish_date: parseTaiwanDate(item.dateText),
        end_date: endDate,
        budget,
        budget_text: budgetText,
        url: detailUrl
      });
      
      // Delay slightly to be polite
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    console.error(`Error scraping acebidx for "${keyword}":`, error.message);
  }
  
  return tenders;
}

// Scrape tenders from official web.pcc.gov.tw (fallback structure)
async function scrapePcc(keyword) {
  console.log(`Scraping web.pcc.gov.tw for keyword: "${keyword}" (Official)...`);
  // Note: Government site has WAF and might block. We try to query it, but gracefully handle failures.
  try {
    const searchUrl = "https://web.pcc.gov.tw/tps/pss/tender.do?searchMode=common&searchType=basic";
    const response = await fetch(searchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      body: new URLSearchParams({
        "method": "search",
        "searchMethod": "true",
        "tenderName": keyword,
        "searchType": "basic",
        "searchMode": "common"
      }).toString()
    });
    
    if (!response.ok) {
      console.warn(`PCC official site returned status ${response.status}. Skipping.`);
      return [];
    }
    
    const html = await response.text();
    if (html.includes("Cloudflare") || html.includes("Just a moment")) {
      console.warn("PCC official site is protected by Cloudflare JS challenge. Skipping official site.");
      return [];
    }
    
    // Parse the results from PCC HTML tables if it succeeded
    const tenders = [];
    // PCC lists tenders in rows with class table_bg or tr containing detail links
    // Here we can parse links like: tender.do?method=tenderDetail&pkPmsMain=xxxx
    const linkRegex = /href="[^"]*method=tenderDetail[^"]*pkPmsMain=([^"&]+)"[^>]*>/gi;
    let match;
    const pks = [];
    while ((match = linkRegex.exec(html)) !== null) {
      pks.push(match[1]);
    }
    
    console.log(`PCC parser found ${pks.length} link keys`);
    // Due to Cloudflare blocks, we log and return empty to let the system fall back to acebidx
    return tenders;
  } catch (error) {
    console.warn(`Failed to scrape pcc.gov.tw: ${error.message}. Fallback to acebidx data.`);
    return [];
  }
}

// Global session cookie for taiwanbuying
let taiwanBuyingCookie = "";

// Login to taiwanbuying.com.tw and retrieve session cookies
async function loginTaiwanBuying(env) {
  const username = env?.TAIWANBUYING_USER || "flaviochang@gamania.com";
  const password = env?.TAIWANBUYING_PASS || "Julie520";
  const loginUrl = "https://www.taiwanbuying.com.tw/MemShowLogin.asp";
  const actionUrl = "https://www.taiwanbuying.com.tw/MemLoginAction.asp";
  
  console.log("Logging in to taiwanbuying.com.tw with account:", username);
  
  try {
    const initRes = await fetch(loginUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    
    if (!initRes.ok) {
      console.error(`Failed to load login page. Status: ${initRes.status}`);
      return "";
    }
    
    const html = await initRes.text();
    const csrfMatch = html.match(/name="csrf_token"\s+value="([^"]+)"/);
    if (!csrfMatch) {
      console.error("Failed to parse csrf_token from login page");
      return "";
    }
    const csrfToken = csrfMatch[1];
    
    const setCookies = initRes.headers.getSetCookie ? initRes.headers.getSetCookie() : (initRes.headers.get("set-cookie") ? [initRes.headers.get("set-cookie")] : []);
    let cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');
    
    const bodyParams = new URLSearchParams();
    bodyParams.append("csrf_token", csrfToken);
    bodyParams.append("LogID", username);
    bodyParams.append("PWD", password);
    bodyParams.append("Submit", "送出");
    
    const loginRes = await fetch(actionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie": cookieHeader
      },
      body: bodyParams.toString(),
      redirect: "manual"
    });
    
    const loginSetCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : (loginRes.headers.get("set-cookie") ? [loginRes.headers.get("set-cookie")] : []);
    if (loginSetCookies.length > 0) {
      const newCookies = loginSetCookies.map(c => c.split(';')[0]).join('; ');
      cookieHeader = [cookieHeader, newCookies].filter(Boolean).join('; ');
    }
    
    console.log("Login to taiwanbuying.com.tw completed.");
    return cookieHeader;
  } catch (error) {
    console.error("Error during login to taiwanbuying.com.tw:", error.message);
    return "";
  }
}

// Fetch detail page from taiwanbuying, following redirects, preserving cookies
async function fetchTaiwanBuyingDetail(recNo, cookieHeader) {
  let url = `https://www.taiwanbuying.com.tw/ShowDetail.ASP?RecNo=${recNo}`;
  let depth = 0;
  
  while (depth < 5) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Cookie": cookieHeader
        },
        redirect: "manual"
      });
      
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
      if (setCookies.length > 0) {
        const newCookies = setCookies.map(c => c.split(';')[0]).join('; ');
        cookieHeader = [cookieHeader, newCookies].filter(Boolean).join('; ');
      }
      
      if (res.status === 302 || res.status === 301) {
        let location = res.headers.get("location");
        if (!location) {
          break;
        }
        if (!location.startsWith("http")) {
          const parsed = new URL(url);
          location = `${parsed.protocol}//${parsed.host}/${location.startsWith('/') ? location.slice(1) : location}`;
        }
        url = location;
        depth++;
      } else if (res.ok) {
        const body = await res.text();
        return { body, cookies: cookieHeader };
      } else {
        console.error(`Failed to fetch detail for RecNo ${recNo}. Status: ${res.status}`);
        break;
      }
    } catch (err) {
      console.error(`Error fetching detail for RecNo ${recNo}:`, err.message);
      break;
    }
  }
  return null;
}

// Parse ROC/standard date with optional time for deadline
function parseDeadlineDate(dateStr) {
  if (!dateStr) return "";
  dateStr = cleanText(dateStr).trim();
  if (dateStr.includes("加值會員專用")) return "";

  const timeMatch = dateStr.match(/(\d{1,2}):(\d{1,2})/);
  const timeStr = timeMatch ? ` ${timeMatch[1].padStart(2, '0')}:${timeMatch[2].padStart(2, '0')}` : '';

  const rocMatch = dateStr.match(/(?:民國)?\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
  if (rocMatch) {
    const year = parseInt(rocMatch[1], 10) + 1911;
    const month = rocMatch[2].padStart(2, '0');
    const day = rocMatch[3].padStart(2, '0');
    return `${year}-${month}-${day}${timeStr}`;
  }

  const ymdMatch = dateStr.match(/(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/);
  if (ymdMatch) {
    const year = ymdMatch[1];
    const month = ymdMatch[2].padStart(2, '0');
    const day = ymdMatch[3].padStart(2, '0');
    return `${year}-${month}-${day}${timeStr}`;
  }

  return dateStr;
}

// Parse budget text from detail page
function parseBudget(budgetStr) {
  if (!budgetStr) return { budget: 0, text: "未公開或未填" };
  budgetStr = budgetStr.replace(/<[^>]+>/g, '').trim();
  if (budgetStr.includes("加值會員專用") || budgetStr.includes("未公開") || budgetStr.includes("未填")) {
    return { budget: 0, text: "未公開或未填" };
  }

  const numMatch = budgetStr.match(/([\d,]+)/);
  if (numMatch) {
    const budgetVal = parseInt(numMatch[1].replace(/,/g, ''), 10);
    if (!isNaN(budgetVal)) {
      return {
        budget: budgetVal,
        text: budgetVal.toLocaleString('zh-TW') + "元"
      };
    }
  }

  return { budget: 0, text: budgetStr };
}

// Scrape tenders from taiwanbuying.com.tw
async function scrapeTaiwanBuying(keyword, env) {
  const tenders = [];
  const url = `https://www.taiwanbuying.com.tw/Query_KeywordAction.ASP?Keyword=${encodeURIComponent(keyword)}`;
  
  console.log(`Scraping taiwanbuying.com.tw for keyword: "${keyword}"...`);
  
  if (!taiwanBuyingCookie) {
    taiwanBuyingCookie = await loginTaiwanBuying(env);
  }
  
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    
    if (!response.ok) {
      console.error(`TaiwanBuying returned status ${response.status}`);
      return [];
    }
    
    const html = await response.text();
    const regex = /href=javascript:openWin\('ShowDetail\.ASP\?RecNo=(\d+)'\)(?:\s+title='([^']*)')?>([\s\S]*?)<\/a>/gi;
    let match;
    const matches = [];
    
    while ((match = regex.exec(html)) !== null) {
      matches.push({
        recNo: match[1],
        titleAttr: match[2] || '',
        textContent: match[3].replace(/<[^>]+>/g, '').trim()
      });
    }
    
    console.log(`Found ${matches.length} matches on taiwanbuying list for "${keyword}"`);
    
    // Fetch details for first 15 biddings to prevent timeout
    const listToFetch = matches.slice(0, 15);
    
    for (const item of listToFetch) {
      const recNo = item.recNo;
      const textContent = item.textContent;
      
      const colonIdx = textContent.indexOf(':');
      let agency = '';
      let fullTitle = textContent;
      
      if (colonIdx !== -1) {
        agency = textContent.substring(0, colonIdx).trim();
        fullTitle = textContent.substring(colonIdx + 1).trim();
      }
      
      const parenMatch = fullTitle.match(/\s*\(([^)]+)\)$/);
      let dateText = '';
      let title = fullTitle;
      
      if (parenMatch) {
        dateText = parenMatch[1].replace(/更新/g, '').trim();
        title = fullTitle.substring(0, parenMatch.index).trim();
      }
      
      const publishDate = parseTaiwanDate(dateText);
      const detailUrl = `https://www.taiwanbuying.com.tw/ShowDetail.ASP?RecNo=${recNo}`;
      const uid = `taiwanbuying_${recNo}`;
      
      let caseNumber = "";
      let endDate = "";
      let budget = 0;
      let budgetText = "未公開或未填";
      
      if (taiwanBuyingCookie) {
        const detailResult = await fetchTaiwanBuyingDetail(recNo, taiwanBuyingCookie);
        if (detailResult) {
          taiwanBuyingCookie = detailResult.cookies;
          const detailHtml = detailResult.body;
          
          // Parse Case Number
          const caseNoMatch = detailHtml.match(/<b>公告單位案號<\/b>\s*:\s*([\s\S]*?)<br>/);
          if (caseNoMatch) {
            const parsedCaseNo = caseNoMatch[1].replace(/<[^>]+>/g, '').trim();
            if (!parsedCaseNo.includes("加值會員專用")) {
              caseNumber = parsedCaseNo;
            }
          }
          
          // Parse End Date
          const deadlineMatch = detailHtml.match(/<b>截止收件日期<\/b>\s*:\s*([\s\S]*?)<br>/);
          if (deadlineMatch) {
            const parsedDeadline = deadlineMatch[1].replace(/<[^>]+>/g, '').trim();
            endDate = parseDeadlineDate(parsedDeadline);
          }
          
          // Parse Budget
          const budgetMatch = detailHtml.match(/<b>預算或預估採購金額<\/b>\s*:\s*([\s\S]*?)<br>/);
          if (budgetMatch) {
            const parsedBudget = parseBudget(budgetMatch[1]);
            budget = parsedBudget.budget;
            budgetText = parsedBudget.text;
          }
        }
      }
      
      tenders.push({
        uid,
        source: "taiwanbuying",
        case_number: caseNumber,
        agency,
        title,
        publish_date: publishDate,
        end_date: endDate,
        budget,
        budget_text: budgetText,
        url: detailUrl
      });
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    console.error(`Error scraping taiwanbuying for "${keyword}":`, error.message);
  }
  
  return tenders;
}

// Helper to escape HTML characters in email body
function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Send email notifications to all registered recipients via Gmail SMTP using worker-mailer
async function sendEmailNotification(recipients, newTenders, env) {
  if (!env || !env.GMAIL_PASS) {
    console.warn("GMAIL_PASS is not configured. Skipping email notification.");
    return;
  }

  const isNoUpdate = newTenders.length === 0;
  let htmlBody = '';

  if (isNoUpdate) {
    htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937; line-height: 1.6; margin: 0; padding: 20px; background-color: #f3f4f6;">
        <div style="max-width: 800px; margin: 0 auto; background-color: #ffffff; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.05); border: 1px solid #e5e7eb;">
          <h2 style="color: #4f46e5; margin-top: 0; font-size: 20px; border-bottom: 2px solid #f3f4f6; padding-bottom: 15px;">
            🍊 雲力橘子_招標資訊分析 - 同步完成通知
          </h2>
          <p style="font-size: 15px; color: #4b5563; text-align: center; padding: 20px 0;">
            <strong>本次系統同步已完成，目前沒有新增 the 招標公告資料。</strong>
          </p>
          <p style="font-size: 12px; color: #9ca3af; margin-top: 30px; border-top: 1px solid #f3f4f6; padding-top: 15px; text-align: center;">
            此郵件為系統自動發送，請勿直接回覆。如有任何疑問，請造訪系統網站。
          </p>
        </div>
      </body>
      </html>
    `;
  } else {
    // Build HTML list of new tenders
    let tenderRowsHtml = '';
    for (const t of newTenders) {
      tenderRowsHtml += `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #eeeeee;">${escapeHtml(t.agency)}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-weight: bold; color: #111827;">${escapeHtml(t.title)}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-family: monospace;">${escapeHtml(t.case_number) || '-'}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eeeeee;">${escapeHtml(t.publish_date)}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eeeeee;">${escapeHtml(t.end_date) || '-'}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eeeeee; font-weight: bold; color: #4f46e5;">${escapeHtml(t.budget_text) || '未公開'}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eeeeee; text-align: center;">
            <a href="${t.url}" target="_blank" style="display: inline-block; padding: 5px 12px; background-color: #4f46e5; color: white; text-decoration: none; border-radius: 6px; font-size: 12px; font-weight: 600;">前往 ➔</a>
          </td>
        </tr>
      `;
    }

    htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937; line-height: 1.6; margin: 0; padding: 20px; background-color: #f3f4f6;">
        <div style="max-width: 800px; margin: 0 auto; background-color: #ffffff; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.05); border: 1px solid #e5e7eb;">
          <h2 style="color: #4f46e5; margin-top: 0; font-size: 20px; border-bottom: 2px solid #f3f4f6; padding-bottom: 15px;">
            🍊 雲力橘子_招標資訊分析 - 新增標案通知
          </h2>
          <p style="font-size: 15px; color: #4b5563;">您好，系統剛才執行了資料同步，為您篩選出以下 <strong>${newTenders.length}</strong> 筆全新的「資訊」、「資安」或「資通安全」相關招標公告：</p>
          
          <div style="overflow-x: auto; margin: 20px 0; border: 1px solid #e5e7eb; border-radius: 8px;">
            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; min-width: 600px;">
              <thead>
                <tr style="background-color: #f9fafb; color: #4b5563;">
                  <th style="padding: 10px; border-bottom: 2px solid #e5e7eb;">機關名稱</th>
                  <th style="padding: 10px; border-bottom: 2px solid #e5e7eb;">標案名稱</th>
                  <th style="padding: 10px; border-bottom: 2px solid #e5e7eb;">標案案號</th>
                  <th style="padding: 10px; border-bottom: 2px solid #e5e7eb;">公告日期</th>
                  <th style="padding: 10px; border-bottom: 2px solid #e5e7eb;">截止投標</th>
                  <th style="padding: 10px; border-bottom: 2px solid #e5e7eb;">預算金額</th>
                  <th style="padding: 10px; border-bottom: 2px solid #e5e7eb; text-align: center;">操作</th>
                </tr>
              </thead>
              <tbody>
                ${tenderRowsHtml}
              </tbody>
            </table>
          </div>
          
          <p style="font-size: 12px; color: #9ca3af; margin-top: 30px; border-top: 1px solid #f3f4f6; padding-top: 15px; text-align: center;">
            此郵件為系統自動發送，請勿直接回覆。如有任何疑問，請造訪系統網站。
          </p>
        </div>
      </body>
      </html>
    `;
  }

  const toList = recipients.map(r => ({ name: r.name || '', email: r.email }));
  const fromEmail = 'surfingflavio@gmail.com';
  const fromName = '雲力橘子_招標資訊分析系統';

  const subjectText = isNoUpdate 
    ? '【雲力橘子】招標資訊分析 - 同步完成通知 (無更新資料)'
    : `【雲力橘子】新增標案通知 (${newTenders.length} 筆新資料)`;

  console.log(`Connecting to Gmail SMTP to send notification to ${toList.length} recipients...`);
  
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

  await mailer.send({
    from: { name: fromName, email: fromEmail },
    to: toList,
    subject: subjectText,
    html: htmlBody
  });

  console.log(`Notification email sent successfully via Gmail SMTP to ${toList.length} recipients. No updates: ${isNoUpdate}`);
}


// Synchronize all tenders into Cloudflare D1 Database
export async function syncTenders(db, env) {
  const keywords = ["資訊", "資安", "資通安全"];
  let totalSaved = 0;
  const newTenders = [];

  // Query existing UIDs from database to detect new ones
  let existingUids = new Set();
  try {
    const { results } = await db.prepare("SELECT uid FROM tenders").all();
    if (results) {
      existingUids = new Set(results.map(r => r.uid));
    }
  } catch (err) {
    console.error("Error fetching existing UIDs for duplicate check:", err);
  }
  
  for (const keyword of keywords) {
    // 1. Scrape from Taiwan Bidding & Procurement Network (acebidx)
    const acebidxTenders = await scrapeAcebidx(keyword);
    
    // 2. Try scraping official PCC site
    const pccTenders = await scrapePcc(keyword);
    
    // 3. Scrape from taiwanbuying.com.tw
    const taiwanBuyingTenders = await scrapeTaiwanBuying(keyword, env);
    
    // Combine lists
    const combined = [...acebidxTenders, ...pccTenders, ...taiwanBuyingTenders];
    
    // 3. Save to database using INSERT OR IGNORE / ON CONFLICT UPDATE
    for (const tender of combined) {
      const isNew = !existingUids.has(tender.uid);
      try {
        const result = await db.prepare(`
          INSERT INTO tenders (uid, source, case_number, agency, title, publish_date, end_date, budget, budget_text, url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(uid) DO UPDATE SET
            case_number = CASE WHEN tenders.is_edited = 1 THEN tenders.case_number ELSE excluded.case_number END,
            agency = CASE WHEN tenders.is_edited = 1 THEN tenders.agency ELSE excluded.agency END,
            title = CASE WHEN tenders.is_edited = 1 THEN tenders.title ELSE excluded.title END,
            publish_date = CASE WHEN tenders.is_edited = 1 THEN tenders.publish_date ELSE excluded.publish_date END,
            end_date = CASE WHEN tenders.is_edited = 1 THEN tenders.end_date ELSE excluded.end_date END,
            budget = CASE WHEN tenders.is_edited = 1 THEN tenders.budget ELSE excluded.budget END,
            budget_text = CASE WHEN tenders.is_edited = 1 THEN tenders.budget_text ELSE excluded.budget_text END,
            url = CASE WHEN tenders.is_edited = 1 THEN tenders.url ELSE excluded.url END
        `).bind(
          tender.uid,
          tender.source,
          tender.case_number,
          tender.agency,
          tender.title,
          tender.publish_date,
          tender.end_date,
          tender.budget,
          tender.budget_text,
          tender.url
        ).run();
        
        if (result.meta?.changes > 0) {
          totalSaved++;
          if (isNew) {
            newTenders.push(tender);
          }
        }
      } catch (err) {
        console.error(`Error saving tender to D1: ${err.message}`);
      }
    }
  }
  
  console.log(`Synchronization finished. Saved/Updated ${totalSaved} biddings. New: ${newTenders.length}`);

  // Send email notifications to all recipients (regardless of whether newTenders.length > 0)
  try {
    const { results: recipients } = await db.prepare("SELECT name, email FROM recipients").all();
    if (recipients && recipients.length > 0) {
      console.log(`Sending email notifications to ${recipients.length} recipients...`);
      await sendEmailNotification(recipients, newTenders, env);
    } else {
      console.log("No recipients found in database. Skipping email notification.");
    }
  } catch (emailErr) {
    console.error("Failed to send email notifications:", emailErr);
  }
  
  return { success: true, count: totalSaved, newCount: newTenders.length, syncTime: new Date().toISOString() };
}
