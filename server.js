// Brand name checker: runs the five checklist lookups for a name and returns JSON.
// No dependencies. Start with `node server.js`, then open http://localhost:4173

const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;

const PORT = process.env.PORT || 4173;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TLDS = ["com", "in", "co.in", "co", "net", "org", "store", "shop"];
const DEAD_MARK = /abandon|refus|withdraw|removed|expired|reject|cancel/i;
const DEAD_COMPANY = /strike|dissolv|amalgamat|liquidat|dormant|inactive/i;
const LEGAL_SUFFIX = /\b(private|pvt|limited|ltd|llp|opc|india|\(india\))\b/gi;

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const decode = (s) =>
  String(s)
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#183;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

async function get(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9", ...(opts.headers || {}) },
    redirect: "follow",
    signal: AbortSignal.timeout(opts.timeout || 15000),
  });
  return { status: res.status, text: opts.statusOnly ? "" : await res.text() };
}

// How close a found name is to the one being checked.
function closeness(found, wanted) {
  const f = norm(found);
  const w = norm(wanted);
  if (!f || !w) return "other";
  if (f === w) return "exact";
  if (f.includes(w) || (f.length >= 4 && w.includes(f))) return "similar";
  return "other";
}

const rank = { exact: 0, similar: 1, other: 2 };

function totalMatches(html) {
  const m = html.match(/([\d,]+)\s+of\s+([\d,]+)\s+Matches/i);
  return m ? Number(m[2].replace(/,/g, "")) : null;
}

async function checkTrademark(name) {
  const url = "https://www.quickcompany.in/trademarks?q=" + encodeURIComponent(name);
  const { status, text } = await get(url);
  if (status !== 200) throw new Error("QuickCompany answered " + status);

  const items = text
    .split(/<turbo-frame id="trademark_/)
    .slice(1)
    .map((chunk) => {
      const link = chunk.match(/href="(\/trademarks\/[^"]+)">([^<]+)<\/a>/);
      if (!link) return null;
      const st = chunk.match(/<div class="lh-lg">\s*<button[^>]*>([^<]*)/);
      const title = decode(link[2]);
      const state = st ? decode(st[1]) : "";
      return {
        name: title,
        url: "https://www.quickcompany.in" + link[1],
        owner: decode((chunk.match(/d-block fs-4">([^<]*)/) || [])[1] || ""),
        state,
        live: !DEAD_MARK.test(state),
        klass: (chunk.match(/Class:\s*(\d+)/) || [])[1] || "",
        date: (chunk.match(/btn-light">\s*(\d{2} \w{3} \d{4})/) || [])[1] || "",
        match: closeness(title, name),
      };
    })
    .filter(Boolean)
    .sort((a, b) => rank[a.match] - rank[b.match]);

  const exactLive = items.filter((i) => i.match === "exact" && i.live);
  const exactDead = items.filter((i) => i.match === "exact" && !i.live);
  const similarLive = items.filter((i) => i.match === "similar" && i.live);
  const classes = [...new Set(exactLive.map((i) => i.klass).filter(Boolean))].sort((a, b) => a - b);

  let verdict = "available";
  let finding = "No trademark filing uses this name or contains it.";
  if (exactLive.length) {
    verdict = "taken";
    finding =
      `${exactLive.length} live filing${exactLive.length > 1 ? "s" : ""} with this exact name` +
      (classes.length ? ` in class ${classes.join(", ")}.` : ".");
  } else if (similarLive.length) {
    verdict = "caution";
    finding = `No exact match, but ${similarLive.length} live mark${similarLive.length > 1 ? "s" : ""} contain this name. Compare the classes.`;
  } else if (exactDead.length) {
    verdict = "caution";
    finding = "The exact name was filed before, but those filings are abandoned, refused or withdrawn.";
  }

  return { verdict, finding, url, total: totalMatches(text), items: items.filter((i) => i.match !== "other").slice(0, 12) };
}

async function checkCompany(name) {
  const url = "https://www.quickcompany.in/company?q=" + encodeURIComponent(name);
  const { status, text } = await get(url);
  if (status !== 200) throw new Error("QuickCompany answered " + status);

  const list = text.slice(Math.max(0, text.indexOf('id="list_results"')));
  const items = list
    .split(/<turbo-frame id="/)
    .slice(1)
    .map((chunk) => {
      const link = chunk.match(/href="(\/company\/[^"]+)">([^<]+)<\/a>/);
      if (!link) return null;
      const st = chunk.match(/<div class="lh-lg">\s*<button[^>]*>([^<]*)/);
      const title = decode(link[2]);
      const state = st ? decode(st[1]) : "";
      return {
        name: title,
        url: "https://www.quickcompany.in" + link[1],
        cin: (chunk.match(/CIN:\s*([A-Z0-9]+)/) || [])[1] || "",
        state,
        live: !DEAD_COMPANY.test(state),
        date: (chunk.match(/btn-light">\s*(\d{2} \w{3} \d{4})/) || [])[1] || "",
        match: closeness(title.replace(LEGAL_SUFFIX, ""), name),
      };
    })
    .filter(Boolean)
    .sort((a, b) => rank[a.match] - rank[b.match]);

  const exactLive = items.filter((i) => i.match === "exact" && i.live);
  const exactDead = items.filter((i) => i.match === "exact" && !i.live);
  const similarLive = items.filter((i) => i.match === "similar" && i.live);

  let verdict = "available";
  let finding = "No registered company uses this name or contains it.";
  if (exactLive.length) {
    verdict = "taken";
    finding = `An active company is already registered as ${exactLive[0].name}.`;
  } else if (similarLive.length) {
    verdict = "caution";
    finding = `No exact match, but ${similarLive.length} active compan${similarLive.length > 1 ? "ies" : "y"} contain this name. The registrar may reject a close name.`;
  } else if (exactDead.length) {
    verdict = "caution";
    finding = "A company had this exact name but is struck off or inactive.";
  }

  return { verdict, finding, url, total: totalMatches(text), items: items.filter((i) => i.match !== "other").slice(0, 12) };
}

async function checkOneDomain(domain) {
  try {
    const { status } = await get("https://rdap.org/domain/" + domain, { statusOnly: true, timeout: 10000 });
    if (status === 200) return { domain, state: "taken", via: "registry" };
    if (status === 404) return { domain, state: "available", via: "registry" };
  } catch {}
  // Registry lookup refused or timed out: fall back to DNS, which is a strong hint but not proof.
  try {
    await dns.resolveNs(domain);
    return { domain, state: "taken", via: "dns" };
  } catch (e) {
    if (e.code === "ENOTFOUND" || e.code === "ENODATA") return { domain, state: "available", via: "dns" };
    return { domain, state: "unknown", via: "" };
  }
}

async function checkDomains(name) {
  const slug = norm(name);
  const items = await Promise.all(TLDS.map((t) => checkOneDomain(`${slug}.${t}`)));
  const state = (tld) => items.find((i) => i.domain === `${slug}.${tld}`).state;
  const free = items.filter((i) => i.state === "available").map((i) => i.domain);

  let verdict = "caution";
  let finding;
  if (state("com") === "available" && state("in") === "available") {
    verdict = "available";
    finding = `${slug}.com and ${slug}.in are both unregistered.`;
  } else if (state("com") === "taken" && state("in") === "taken") {
    verdict = free.length ? "caution" : "taken";
    finding = free.length
      ? `.com and .in are registered. Still free: ${free.join(", ")}.`
      : "Every extension checked is already registered.";
  } else {
    const taken = state("com") === "taken" ? ".com" : state("in") === "taken" ? ".in" : null;
    finding = taken
      ? `${taken} is registered; ${taken === ".com" ? ".in" : ".com"} is ${state(taken === ".com" ? "in" : "com") === "available" ? "free" : "unconfirmed"}.`
      : "Could not confirm .com and .in. Check them at the registrar.";
  }

  return {
    verdict,
    finding,
    url: "https://www.godaddy.com/en-in/domainsearch/find?domainToCheck=" + encodeURIComponent(slug),
    items,
  };
}

async function probe(platform, handle, profileUrl, auto) {
  const item = { platform, handle, url: profileUrl, state: "manual" };
  if (!auto) return item;
  try {
    const { status } = await get(profileUrl, { statusOnly: true, timeout: 12000 });
    if (status === 200) item.state = "taken";
    else if (status === 404) item.state = "available";
  } catch {}
  return item;
}

async function checkSocial(name) {
  const h = norm(name);
  // Instagram and Facebook serve the same page for real and missing profiles
  // unless you are signed in, so those two are left for a manual look.
  const items = await Promise.all([
    probe("Instagram", "@" + h, `https://www.instagram.com/${h}/`, false),
    probe("YouTube", "@" + h, `https://www.youtube.com/@${h}`, true),
    probe("X (Twitter)", "@" + h, `https://x.com/${h}`, true),
    probe("LinkedIn", "company/" + h, `https://www.linkedin.com/company/${h}`, true),
    probe("Facebook", h, `https://www.facebook.com/${h}`, false),
  ]);

  const checked = items.filter((i) => i.state === "taken" || i.state === "available");
  const taken = checked.filter((i) => i.state === "taken");
  const manual = items.filter((i) => i.state === "manual").map((i) => i.platform);
  const tail = manual.length ? ` Check ${manual.join(" and ")} by hand.` : "";

  let verdict = "manual";
  let finding = `Handle is free on ${checked.map((i) => i.platform).join(", ") || "none confirmed"}.` + tail;
  if (taken.length && taken.length === checked.length) {
    verdict = "taken";
    finding = `Handle is in use on ${taken.map((i) => i.platform).join(", ")}.` + tail;
  } else if (taken.length) {
    verdict = "caution";
    finding = `Handle is in use on ${taken.map((i) => i.platform).join(", ")}.` + tail;
  }
  return { verdict, finding, items };
}

async function checkWeb(name) {
  const query = `"${name}"`;
  const google = "https://www.google.com/search?q=" + encodeURIComponent(query);
  const { status, text } = await get("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query));
  const blocks = text.split('class="result__a"').slice(1, 11);
  if (status !== 200 || /anomaly|challenge-form/i.test(text)) {
    throw new Error("search refused");
  }
  if (!blocks.length) {
    return { verdict: "available", finding: "A search for the exact name returns no results at all.", url: google, items: [] };
  }

  const wanted = norm(name);
  const items = blocks.map((b) => {
    const title = decode((b.match(/^[^>]*>([\s\S]*?)<\/a>/) || [])[1] || "");
    const raw = (b.match(/href="([^"]+)"/) || [])[1] || "";
    let link = raw.replace(/&amp;/g, "&");
    const uddg = link.match(/[?&]uddg=([^&]+)/);
    if (uddg) link = decodeURIComponent(uddg[1]);
    let host = "";
    try {
      host = new URL(link).hostname.replace(/^www\./, "");
    } catch {}
    const uses = norm(title).includes(wanted) || norm(host.split(".")[0]).includes(wanted);
    return { title, url: link, host, uses };
  });

  const users = items.filter((i) => i.uses).length;
  let verdict = "available";
  let finding = "Nothing on the first page of results uses this name.";
  if (users >= 4) {
    verdict = "taken";
    finding = `${users} of the top ${items.length} results already use this name. You would compete with them for the first page.`;
  } else if (users > 0) {
    verdict = "caution";
    finding = `${users} of the top ${items.length} results already use this name.`;
  }
  return { verdict, finding, url: google, items };
}

const CHECKS = { trademark: checkTrademark, company: checkCompany, domains: checkDomains, social: checkSocial, web: checkWeb };

// Pre-filled search pages, offered when a site refuses the automatic check.
const MANUAL_LINK = {
  trademark: (n) => "https://www.quickcompany.in/trademarks?q=" + encodeURIComponent(n),
  company: (n) => "https://www.quickcompany.in/company?q=" + encodeURIComponent(n),
  web: (n) => "https://www.google.com/search?q=" + encodeURIComponent('"' + n + '"'),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/check") {
    const name = (url.searchParams.get("name") || "").trim().slice(0, 80);
    const check = CHECKS[url.searchParams.get("check")];
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (!check || norm(name).length < 2) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Enter a name with at least two letters or digits." }));
    }
    try {
      res.end(JSON.stringify(await check(name)));
    } catch (e) {
      const link = MANUAL_LINK[url.searchParams.get("check")];
      res.end(
        JSON.stringify({
          verdict: link ? "manual" : "unknown",
          finding: link
            ? "This site refused the automatic check. Open the search below to see the results yourself."
            : "The lookup failed. Try again in a minute.",
          url: link ? link(name) : undefined,
          items: [],
        })
      );
    }
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
  }
  res.statusCode = 404;
  res.end("Not found");
});

server.listen(PORT, () => console.log(`Brand name checker running at http://localhost:${PORT}`));
