// SEC EDGAR filings poller. Free, no API key. SEC requires a descriptive User-Agent.
const UA = "sharpEdge personal-use arnavjainone@gmail.com";

// Material form types worth alerting on.
const MATERIAL_FORMS = new Set([
  "8-K", "8-K/A",          // material events
  "10-Q", "10-K",          // quarterly/annual reports
  "13D", "13D/A", "SC 13D", "SC 13D/A", // activist stakes
  "SC 13G", "SC 13G/A",    // passive >5% stakes
  "S-1", "S-3", "424B5",   // offerings / dilution
  "4",                     // insider transactions
  "6-K",                   // foreign issuer reports
]);

const tickerToCik = new Map<string, string>();

export async function loadCikMap(tickers: string[]) {
  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`EDGAR ticker map ${res.status}`);
  const data = (await res.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;
  const wanted = new Set(tickers);
  for (const entry of Object.values(data)) {
    if (wanted.has(entry.ticker.toUpperCase())) {
      tickerToCik.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, "0"));
    }
  }
  console.log(`[edgar] resolved CIKs for ${tickerToCik.size}/${tickers.length} tickers`);
}

export interface Filing {
  ticker: string;
  form: string;
  filedAt: string; // ISO date
  accession: string;
  description: string;
  url: string;
}

// Poll recent filings for one ticker via the submissions API.
export async function fetchRecentFilings(ticker: string, sinceISO: string): Promise<Filing[]> {
  const cik = tickerToCik.get(ticker);
  if (!cik) return [];
  const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as any;
  const recent = data.filings?.recent;
  if (!recent) return [];

  const out: Filing[] = [];
  for (let i = 0; i < recent.form.length && i < 40; i++) {
    const form = recent.form[i];
    const filedAt = recent.filingDate[i];
    if (filedAt < sinceISO) break; // list is newest-first
    if (!MATERIAL_FORMS.has(form)) continue;
    const accession = recent.accessionNumber[i];
    out.push({
      ticker,
      form,
      filedAt,
      accession,
      description: recent.primaryDocDescription?.[i] || form,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${recent.primaryDocument[i]}`,
    });
  }
  return out;
}
