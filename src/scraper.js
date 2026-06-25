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

// Synchronize all tenders into Cloudflare D1 Database
export async function syncTenders(db) {
  const keywords = ["資訊", "資安", "資通安全"];
  let totalSaved = 0;
  
  for (const keyword of keywords) {
    // 1. Scrape from Taiwan Bidding & Procurement Network (acebidx)
    const acebidxTenders = await scrapeAcebidx(keyword);
    
    // 2. Try scraping official PCC site
    const pccTenders = await scrapePcc(keyword);
    
    // Combine lists
    const combined = [...acebidxTenders, ...pccTenders];
    
    // 3. Save to database using INSERT OR IGNORE
    for (const tender of combined) {
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
        }
      } catch (err) {
        console.error(`Error saving tender to D1: ${err.message}`);
      }
    }
  }
  
  console.log(`Synchronization finished. Saved/Updated ${totalSaved} biddings.`);
  return { success: true, count: totalSaved };
}
