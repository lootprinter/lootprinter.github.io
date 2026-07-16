/* ============================================================
   LOOT · front-end logic
   Reads the DividendDistributor live from RobinhoodChain,
   converts WETH rewards to USD, and powers the wallet checker.
   ============================================================ */

/* ---------------------------------------------------------------
   CONFIG  ⚙️  change these to your real deployed addresses.
   The distributor address is a placeholder; swap in the real one.
   --------------------------------------------------------------- */
const CONFIG = {
  RPC_URL: "https://rpc.mainnet.chain.robinhood.com",

  // 🔴 PLACEHOLDER: replace with the real DividendDistributor address.
  DISTRIBUTOR_ADDRESS: "0x4f0eBa5E4B81546f4556A39A65020bf7c7C79408",

  // Reward token is WETH → 18 decimals, priced as ETH.
  REWARD_DECIMALS: 18,

  // How the reward token is priced in USD (CoinGecko id). WETH ≈ ETH.
  PRICE_COINGECKO_ID: "ethereum",

  // Auto-refresh the dashboard every N ms (0 = off).
  REFRESH_MS: 45000,
};

/* Minimal ABI: only the read-only views the site needs. */
const DISTRIBUTOR_ABI = [
  "function totalDistributed() view returns (uint256)",
  "function totalDividends() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function dividendsPerShare() view returns (uint256)",
  "function shareholderCount() view returns (uint256)",
  "function minDistribution() view returns (uint256)",
  "function minPeriod() view returns (uint256)",
  "function rewardThreshold() view returns (uint256)",
  "function rewardToken() view returns (address)",
  "function getUnpaidEarnings(address) view returns (uint256)",
  "function getLastClaimTime(address) view returns (uint256)",
  "function shares(address) view returns (uint256 amount, uint256 totalExcluded, uint256 totalRealised)",
];

/* --------------------------- State --------------------------- */
let provider = null;
let distributor = null;
let ethUsd = 0;
const isPlaceholder = /^0x0+$/.test(CONFIG.DISTRIBUTOR_ADDRESS.replace(/^0x/, "0x"));

/* --------------------------- Helpers --------------------------- */
const $ = (id) => document.getElementById(id);

function fmtEth(bnLike, maxFrac = 4) {
  try {
    const n = Number(ethers.formatUnits(bnLike, CONFIG.REWARD_DECIMALS));
    if (n === 0) return "0";
    if (n < 0.0001) return n.toExponential(2);
    return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
  } catch { return "0"; }
}

function ethNumber(bnLike) {
  try { return Number(ethers.formatUnits(bnLike, CONFIG.REWARD_DECIMALS)); }
  catch { return 0; }
}

function fmtUsd(ethAmount) {
  if (!ethUsd || !ethAmount) return "≈ $0.00";
  const usd = ethAmount * ethUsd;
  return "≈ $" + usd.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: usd < 1000 ? 2 : 0,
  });
}

function fmtInt(bnLike) {
  try { return Number(bnLike).toLocaleString(); } catch { return "0"; }
}

function fmtDuration(seconds) {
  const s = Number(seconds);
  if (!s) return "Instant";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} hrs`;
  return `${(s / 86400).toFixed(1)} days`;
}

function timeAgo(tsSeconds) {
  const ts = Number(tsSeconds);
  if (!ts) return { abs: "Never", rel: "No payout yet" };
  const d = new Date(ts * 1000);
  const diff = Math.floor(Date.now() / 1000) - ts;
  let rel;
  if (diff < 60) rel = "just now";
  else if (diff < 3600) rel = `${Math.floor(diff / 60)} min ago`;
  else if (diff < 86400) rel = `${Math.floor(diff / 3600)} hrs ago`;
  else rel = `${Math.floor(diff / 86400)} days ago`;
  return { abs: d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }), rel };
}

function setStatus(state, msg) {
  const dot = $("rpcDot");
  dot.className = "dot" + (state === "ok" ? " ok" : state === "err" ? " err" : "");
  $("rpcStatus").textContent = msg;
}

/* --------------------------- Price feed --------------------------- */
async function loadEthPrice() {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${CONFIG.PRICE_COINGECKO_ID}&vs_currencies=usd`,
      { cache: "no-store" }
    );
    const data = await res.json();
    ethUsd = data?.[CONFIG.PRICE_COINGECKO_ID]?.usd || 0;
  } catch {
    ethUsd = 0;
  }
  if (ethUsd) {
    $("statEthPrice").innerHTML = "$" + ethUsd.toLocaleString(undefined, { maximumFractionDigits: 0 });
  } else {
    $("statEthPrice").textContent = "unavailable";
  }
}

/* --------------------------- Provider --------------------------- */
function initProvider() {
  provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  distributor = new ethers.Contract(CONFIG.DISTRIBUTOR_ADDRESS, DISTRIBUTOR_ABI, provider);
}

/* --------------------------- Dashboard --------------------------- */
async function loadDashboard() {
  if (isPlaceholder) {
    setStatus("err", "Distributor address not set yet. Add the real address in app.js to go live.");
    const awaiting = '<span class="await">Not deployed yet</span>';
    ["statTotalEth", "statPoolEth", "statCommittedEth", "statHolders", "statMinPeriod"].forEach((id) => {
      $(id).innerHTML = awaiting;
    });
    $("statTotalUsd").textContent = "Awaiting contract";
    $("statPoolUsd").textContent = "Awaiting contract";
    $("statCommittedUsd").textContent = "Awaiting contract";
    return;
  }

  setStatus("", "Reading the vault…");
  try {
    const [totalDist, totalDiv, holders, minPeriod] = await Promise.all([
      distributor.totalDistributed(),
      distributor.totalDividends(),
      distributor.shareholderCount(),
      distributor.minPeriod(),
    ]);

    const distEth = ethNumber(totalDist);
    const divEth = ethNumber(totalDiv);
    const poolBn = totalDiv > totalDist ? totalDiv - totalDist : 0n;
    const poolEth = ethNumber(poolBn);

    $("statTotalEth").innerHTML = `${fmtEth(totalDist)} <em>ETH</em>`;
    $("statTotalUsd").textContent = fmtUsd(distEth);

    $("statPoolEth").innerHTML = `${fmtEth(poolBn)} <em>ETH</em>`;
    $("statPoolUsd").textContent = fmtUsd(poolEth);

    $("statCommittedEth").innerHTML = `${fmtEth(totalDiv)} <em>ETH</em>`;
    $("statCommittedUsd").textContent = fmtUsd(divEth);

    $("statHolders").textContent = fmtInt(holders);
    $("statMinPeriod").textContent = fmtDuration(minPeriod);

    setStatus("ok", "Live on RobinhoodChain · updated " + new Date().toLocaleTimeString());
  } catch (err) {
    console.error(err);
    setStatus("err", "Couldn't reach the contract. Check the RPC / address, then Refresh.");
  }
}

/* --------------------------- Wallet checker --------------------------- */
async function checkWallet() {
  const raw = $("walletInput").value.trim();
  const hint = $("checkerHint");
  const results = $("checkerResults");

  if (!ethers.isAddress(raw)) {
    hint.textContent = "That doesn't look like a valid 0x wallet address.";
    hint.className = "checker-hint err";
    results.hidden = true;
    return;
  }
  if (isPlaceholder) {
    hint.textContent = "The distributor address hasn't been set yet. Add it in app.js to enable lookups.";
    hint.className = "checker-hint err";
    results.hidden = true;
    return;
  }

  const addr = ethers.getAddress(raw);
  hint.textContent = "Raiding the ledger…";
  hint.className = "checker-hint";
  $("checkBtn").disabled = true;

  try {
    const [unpaid, lastClaim, shareData] = await Promise.all([
      distributor.getUnpaidEarnings(addr),
      distributor.getLastClaimTime(addr),
      distributor.shares(addr),
    ]);

    const realised = shareData.totalRealised; // already received
    const shareAmount = shareData.amount;     // eligible LOOT balance

    const receivedEth = ethNumber(realised);
    const pendingEth = ethNumber(unpaid);

    $("resReceivedEth").innerHTML = `${fmtEth(realised)} <em>ETH</em>`;
    $("resReceivedUsd").textContent = fmtUsd(receivedEth);

    $("resPendingEth").innerHTML = `${fmtEth(unpaid)} <em>ETH</em>`;
    $("resPendingUsd").textContent = fmtUsd(pendingEth);

    $("resShares").textContent = Number(ethers.formatUnits(shareAmount, 18))
      .toLocaleString(undefined, { maximumFractionDigits: 0 }) + " LOOT";

    const t = timeAgo(lastClaim);
    $("resLastClaim").textContent = t.abs;
    $("resLastClaimRel").textContent = t.rel;

    results.hidden = false;
    hint.textContent = `Showing loot for ${addr.slice(0, 6)}…${addr.slice(-4)}`;
  } catch (err) {
    console.error(err);
    hint.textContent = "Lookup failed. The address may not be a holder, or the RPC is down.";
    hint.className = "checker-hint err";
    results.hidden = true;
  } finally {
    $("checkBtn").disabled = false;
  }
}

/* --------------------------- Nav / UI --------------------------- */
function initUI() {
  const nav = $("nav");
  window.addEventListener("scroll", () => {
    nav.classList.toggle("scrolled", window.scrollY > 20);
  });

  const toggle = $("navToggle");
  const links = $("navLinks");
  toggle.addEventListener("click", () => {
    links.classList.toggle("open");
    toggle.classList.toggle("open");
  });
  links.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => {
      links.classList.remove("open");
      toggle.classList.remove("open");
    })
  );

  $("checkBtn").addEventListener("click", checkWallet);
  $("walletInput").addEventListener("keydown", (e) => { if (e.key === "Enter") checkWallet(); });
  $("refreshBtn").addEventListener("click", async () => {
    await loadEthPrice();
    await loadDashboard();
  });

  // Copy contract address
  const copyBtn = $("copyContract");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const addr = $("contractAddr").textContent.trim();
      try {
        await navigator.clipboard.writeText(addr);
      } catch {
        // Fallback for non-secure contexts
        const t = document.createElement("textarea");
        t.value = addr; document.body.appendChild(t);
        t.select(); document.execCommand("copy"); t.remove();
      }
      const original = copyBtn.textContent;
      copyBtn.textContent = "Copied ✓";
      copyBtn.classList.add("copied");
      setTimeout(() => { copyBtn.textContent = original; copyBtn.classList.remove("copied"); }, 1600);
    });
  }
}

/* --------------------------- Gold particle canvas --------------------------- */
function initParticles() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = $("fx");
  const ctx = canvas.getContext("2d");
  let w, h, particles;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    const count = Math.min(70, Math.floor((w * h) / 26000));
    particles = Array.from({ length: count }, () => spawn());
  }
  function spawn() {
    const gold = Math.random() > 0.45;
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 2 + 0.6,
      vy: Math.random() * 0.35 + 0.08,
      vx: (Math.random() - 0.5) * 0.25,
      a: Math.random() * 0.5 + 0.2,
      color: gold ? "245,197,66" : "163,230,53",
    };
  }
  function tick() {
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) {
      p.y += p.vy; p.x += p.vx;
      if (p.y > h + 5) { p.y = -5; p.x = Math.random() * w; }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.color},${p.a})`;
      ctx.shadowBlur = 8; ctx.shadowColor = `rgba(${p.color},0.6)`;
      ctx.fill();
    }
    requestAnimationFrame(tick);
  }
  window.addEventListener("resize", resize);
  resize();
  tick();
}

/* --------------------------- Boot --------------------------- */
(async function boot() {
  initUI();
  initParticles();
  initProvider();
  await loadEthPrice();
  await loadDashboard();
  if (CONFIG.REFRESH_MS > 0) {
    setInterval(async () => { await loadEthPrice(); await loadDashboard(); }, CONFIG.REFRESH_MS);
  }
})();
