// engine.jsx — Kevin's Dice rules + simple AI
// Pure functions wherever possible; state shape lives in app.jsx.

// ── Bid ordering ──────────────────────────────────────────────
// effective(q, f) = q*2 if f===1 else q
// New bid must beat prev on (effective, face) lexicographically.
function effective(q, f) { return f === 1 ? q * 2 : q; }

function bidBeats(next, prev) {
  if (!prev) return next.q >= 1; // any bid is legal as opener
  const eN = effective(next.q, next.f);
  const eP = effective(prev.q, prev.f);
  if (eN > eP) return true;
  if (eN < eP) return false;
  return next.f > prev.f;
}

// ── Total dice still in play, total hidden dice (for AI) ──────
function totalDice(players) {
  return players.reduce((s, p) => s + p.dice.length, 0);
}

// ── Enumerate all legal next bids given the standing bid ──────
// Caps quantity at totalDice to keep the grid finite.
function legalBids(prev, totalDiceCount) {
  const out = [];
  for (let q = 1; q <= totalDiceCount; q++) {
    for (let f = 1; f <= 6; f++) {
      if (bidBeats({ q, f }, prev)) out.push({ q, f });
    }
  }
  return out;
}

// ── Show-and-reroll legality ──────────────────────────────────
// Player can show iff: there's a current bid, at least 1 hidden die "supports"
// the bid (literal f, or any 1 if f !== 1), AND at least 1 hidden die does NOT.
// `selectedIdxs` is the set of hidden-die indices the user has tapped to reveal.
// They must all be supporters; must be non-empty; must leave ≥1 hidden die.
function supportsBid(face, bidFace) {
  if (face === bidFace) return true;
  if (bidFace !== 1 && face === 1) return true;
  return false;
}

function canShowReroll(player, bid) {
  if (!bid) return false;
  const hidden = player.dice.map((d, i) => ({ ...d, i })).filter((d) => !d.revealed);
  if (hidden.length < 2) return false;
  const supporters = hidden.filter((d) => supportsBid(d.face, bid.f));
  return supporters.length >= 1 && supporters.length < hidden.length;
}

// ── Challenge resolution ──────────────────────────────────────
// Returns { actual, threshold, bidderWins }.
function resolveChallenge(players, bid) {
  let actual = 0;
  for (const p of players) for (const d of p.dice) {
    if (d.face === bid.f) actual++;
    else if (bid.f !== 1 && d.face === 1) actual++;
  }
  return { actual, threshold: bid.q, bidderWins: actual >= bid.q };
}

// ── AI ────────────────────────────────────────────────────────
// Simple but plausible: estimate matches given own dice + uniform priors on
// hidden dice; raise to the smallest legal bid whose expected count comfortably
// exceeds threshold, else call liar.
function aiTurn(player, players, bid) {
  const own = player.dice;
  const ownHidden = own.filter((d) => !d.revealed);
  const others = players.filter((p) => p.id !== player.id);
  // Public revealed dice from others count as known.
  const otherRevealed = [];
  let otherHiddenCount = 0;
  for (const p of others) {
    for (const d of p.dice) {
      if (d.revealed) otherRevealed.push(d.face);
      else otherHiddenCount++;
    }
  }
  // Own revealed face counts:
  const knownMatches = (face) => {
    let n = 0;
    for (const d of own) if (supportsBid(d.face, face)) n++;
    for (const f of otherRevealed) if (supportsBid(f, face)) n++;
    return n;
  };
  // Per-hidden-die match probability:
  const matchProb = (face) => face === 1 ? 1 / 6 : 2 / 6;

  // Decide call vs raise on standing bid:
  if (bid) {
    const known = knownMatches(bid.f);
    const need = bid.q - known;
    const p = matchProb(bid.f);
    const meanRem = otherHiddenCount * p;
    // Sloppy normal approx:
    const sd = Math.sqrt(otherHiddenCount * p * (1 - p)) || 0.5;
    const z = (need - 0.5 - meanRem) / sd; // probability that actual < q
    // If z is large positive, the bid is very likely a lie.
    const liarConfidence = z; // >1 means lie likely
    // Try to find a comfortable raise:
    const total = totalDice(players);
    const candidates = legalBids(bid, total);
    let bestRaise = null;
    for (const c of candidates) {
      const k = knownMatches(c.f);
      const needC = c.q - k;
      const meanC = otherHiddenCount * matchProb(c.f);
      const sdC = Math.sqrt(otherHiddenCount * matchProb(c.f) * (1 - matchProb(c.f))) || 0.5;
      const zC = (needC - 0.5 - meanC) / sdC;
      // We want bids that look TRUE for us (zC negative — needed count is below mean).
      const score = -zC + Math.random() * 0.3; // a touch of noise
      if (!bestRaise || score > bestRaise.score) bestRaise = { ...c, score, zC };
    }
    if (liarConfidence > 0.8 && (!bestRaise || bestRaise.zC > -0.2)) {
      return { action: 'liar' };
    }
    if (bestRaise && bestRaise.zC < 0.3) {
      return { action: 'bid', q: bestRaise.q, f: bestRaise.f };
    }
    // Default: call liar if nothing safe.
    return { action: 'liar' };
  }

  // Opener: pick a face we have lots of, bid (own count + ~1/3 of hidden).
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of own) counts[d.face]++;
  let bestF = 2, bestScore = -1;
  for (let f = 2; f <= 6; f++) {
    const sc = counts[f] + counts[1] + Math.random() * 0.5;
    if (sc > bestScore) { bestScore = sc; bestF = f; }
  }
  const total = totalDice(players);
  const have = counts[bestF] + counts[1];
  const remHidden = total - own.length;
  const q = Math.max(1, Math.round(have + remHidden / 3.5));
  return { action: 'bid', q, f: bestF };
}

Object.assign(window, {
  effective, bidBeats, legalBids, supportsBid, canShowReroll,
  resolveChallenge, aiTurn, totalDice,
});
