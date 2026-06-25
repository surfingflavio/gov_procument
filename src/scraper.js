// src/scraper.js

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

// Send email notifications to all registered recipients via MailChannels API
async function sendEmailNotification(recipients, newTenders) {
  const sendEmailURL = 'https://api.mailchannels.net/tx/v1/send';

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
            <strong>本次系統同步已完成，目前沒有新增的招標公告資料。</strong>
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

  // Build standard personalizations to-list for MailChannels
  const toList = recipients.map(r => ({
    email: r.email,
    name: r.name
  }));

  const subjectText = isNoUpdate 
    ? '【雲力橘子】招標資訊分析 - 同步完成通知 (無更新資料)'
    : `【雲力橘子】新增標案通知 (${newTenders.length} 筆新資料)`;

  const payload = {
    personalizations: [
      {
        to: toList
      }
    ],
    from: {
      email: 'flaviochang@gamania.com',
      name: '雲力橘子_招標資訊分析系統'
    },
    subject: subjectText,
    content: [
      {
        type: 'text/html',
        value: htmlBody
      }
    ]
  };

  const res = await fetch(sendEmailURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MailChannels returned status ${res.status}: ${errText}`);
  }

  console.log(`Notification email sent successfully to ${toList.length} recipients. No updates: ${isNoUpdate}`);
}

// Synchronize all tenders into Cloudflare D1 Database
export async function syncTenders(db) {
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
    
    // Combine lists
    const combined = [...acebidxTenders, ...pccTenders];
    
    // 3. Save to database using INSERT OR IGNORE / ON CONFLICT UPDATE
    for (const tender of combined) {
      const isNew = !existingUids.has(tender.uid);
      try {
        const result = await db.prepare(`
          INSERT INTO tenders (uid, source, case_number, agency, title, publish_date, end_date, budget, budget_text, url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(uid) DO UPDATE SET
            case_number = excluded.case_number,
            agency = excluded.agency,
            title = excluded.title,
            publish_date = excluded.publish_date,
            end_date = excluded.end_date,
            budget = excluded.budget,
            budget_text = excluded.budget_text
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
      await sendEmailNotification(recipients, newTenders);
    } else {
      console.log("No recipients found in database. Skipping email notification.");
    }
  } catch (emailErr) {
    console.error("Failed to send email notifications:", emailErr);
  }
  
  return { success: true, count: totalSaved, newCount: newTenders.length };
}
