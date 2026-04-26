// policy.jsx — drives AI seats with the ONNX-exported KevinsDiceNet.
//
// Mirrors `python/general_games/policies/kevins_dice.py`:
//   * `encodeObs`       ↔ `encode(snap, n, is_show_reroll_phase)`
//   * `bidMoveFeatures` ↔ `_bid_move_features`
//   * `showRerollMoveFeatures` ↔ `_show_reroll_move_features`
// The exported graph (gui/policy.onnx) takes (obs[obs_dim],
// move_features[n,9]) and returns scores[n]; we argmax to pick a move.
//
// All exported helpers are stuck on `window` so app.jsx can reach them.

const NUM_FACES = 6;
const MOVE_FEAT_DIM = 9;

// Match the WASM bundle to the umd script tag in Kevin's Dice.html.
ort.env.wasm.wasmPaths =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
// Single-threaded WASM avoids needing COOP/COEP headers for
// SharedArrayBuffer; the model is tiny so threading wouldn't help anyway.
ort.env.wasm.numThreads = 1;

let _session = null;
let _sessionPromise = null;

function loadPolicy(path = 'policy.onnx') {
  if (_session) return Promise.resolve(_session);
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = ort.InferenceSession.create(path, {
    executionProviders: ['wasm'],
  }).then((s) => { _session = s; return s; });
  return _sessionPromise;
}

// ── Encoding helpers (mirror the Python `encode`) ──────────────
function _faceHist(faces) {
  const h = new Float32Array(NUM_FACES);
  for (const f of faces) {
    const fi = Math.trunc(f);
    if (fi >= 1 && fi <= NUM_FACES) h[fi - 1] += 1;
  }
  return h;
}

function encodeObs(players, perspectiveIdx, currentBid, bidderIdx, isShowRerollPhase) {
  const n = players.length;
  const me = perspectiveIdx;

  // Own state.
  const myDice          = players[me].dice;
  const myFullFaces     = myDice.map((d) => d.face);
  const myRevealedFaces = myDice.filter((d) => d.revealed).map((d) => d.face);
  const fullHist     = _faceHist(myFullFaces);
  const revealedHist = _faceHist(myRevealedFaces);
  const hiddenHist   = new Float32Array(NUM_FACES);
  for (let i = 0; i < NUM_FACES; i++) hiddenHist[i] = fullHist[i] - revealedHist[i];

  // Others, cyclic from me+1.
  const otherBlocks = [];
  for (let k = 1; k < n; k++) {
    const p = (me + k) % n;
    const cnt   = players[p].dice.length;
    const alive = players[p].alive ? 1.0 : 0.0;
    const revH  = _faceHist(players[p].dice.filter((d) => d.revealed).map((d) => d.face));
    const block = new Float32Array(8);
    block[0] = cnt;
    block[1] = alive;
    block.set(revH, 2);
    otherBlocks.push(block);
  }

  // Bid block.
  const bidBlock = new Float32Array(6);
  if (currentBid && bidderIdx != null) {
    const eff = currentBid.f === 1 ? currentBid.q * 2 : currentBid.q;
    bidBlock[0] = 1.0;
    bidBlock[1] = currentBid.q;
    bidBlock[2] = currentBid.f;
    bidBlock[3] = eff;
    bidBlock[4] = bidderIdx === me ? 1.0 : 0.0;
    bidBlock[5] = ((bidderIdx - me) % n + n) % n;
  }

  // Concatenate: hidden_hist (6) + revealed_hist (6) + own_dice_count (1)
  // + others_block ((n-1)*8) + bid_block (6) + phase (1)
  const obsDim = 6 + 6 + 1 + (n - 1) * 8 + 6 + 1;
  const obs = new Float32Array(obsDim);
  let o = 0;
  obs.set(hiddenHist, o);   o += 6;
  obs.set(revealedHist, o); o += 6;
  obs[o++] = myDice.length;
  for (const b of otherBlocks) { obs.set(b, o); o += 8; }
  obs.set(bidBlock, o); o += 6;
  obs[o++] = isShowRerollPhase ? 1.0 : 0.0;
  return obs;
}

// ── Move-feature packing ───────────────────────────────────────
// Layout per row:
//   [is_bid, is_call_liar, is_show_reroll, is_skip,
//    quantity, face, effective, n_revealed, n_1s_revealed]
function bidMoveFeatures(legalBids, includeCallLiar) {
  // Order: optional [call_liar] first, then bids. The model is
  // permutation-invariant w.r.t. this ordering — we only care that the
  // index we sample is mapped back consistently below.
  const n = legalBids.length + (includeCallLiar ? 1 : 0);
  const flat = new Float32Array(n * MOVE_FEAT_DIM);
  let row = 0;
  if (includeCallLiar) {
    flat[row * MOVE_FEAT_DIM + 1] = 1.0; // is_call_liar
    row++;
  }
  for (const { q, f } of legalBids) {
    const eff = f === 1 ? q * 2 : q;
    const off = row * MOVE_FEAT_DIM;
    flat[off + 0] = 1.0;     // is_bid
    flat[off + 4] = q;
    flat[off + 5] = f;
    flat[off + 6] = eff;
    row++;
  }
  return flat;
}

function showRerollMoveFeatures(optionFaces /* array of arrays-of-revealed-faces; [] = skip */) {
  // Index 0 should always be skip ([]); subsequent options each describe
  // a distinct reveal subset by the faces they would commit publicly.
  const n = optionFaces.length;
  const flat = new Float32Array(n * MOVE_FEAT_DIM);
  for (let i = 0; i < n; i++) {
    const faces = optionFaces[i];
    if (faces.length === 0) {
      flat[i * MOVE_FEAT_DIM + 3] = 1.0;   // is_skip
    } else {
      flat[i * MOVE_FEAT_DIM + 2] = 1.0;   // is_show_reroll
      flat[i * MOVE_FEAT_DIM + 7] = faces.length;
      flat[i * MOVE_FEAT_DIM + 8] = faces.filter((f) => f === 1).length;
    }
  }
  return flat;
}

// ── ONNX inference ─────────────────────────────────────────────
async function _scoreMoves(obs, moveFeatsFlat, nMoves) {
  const sess = await loadPolicy();
  const obsTensor   = new ort.Tensor('float32', obs, [obs.length]);
  const movesTensor = new ort.Tensor('float32', moveFeatsFlat, [nMoves, MOVE_FEAT_DIM]);
  const out = await sess.run({ obs: obsTensor, move_features: movesTensor });
  return Array.from(out.scores.data);   // length nMoves
}

function _argmax(arr) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[best]) best = i;
  return best;
}

// ── High-level: the AI's bid decision ──────────────────────────
async function policyChooseBid(players, currentBid, perspectiveIdx, history, totalDice) {
  // Enumerate legal bids; include "call liar" iff there's a standing bid.
  const bids = legalBids(currentBid, totalDice);
  const includeLiar = !!currentBid;
  const bidderIdx = currentBid && history.length
    ? players.findIndex((p) => p.id === history[history.length - 1].playerId)
    : null;
  const obs = encodeObs(players, perspectiveIdx, currentBid, bidderIdx, /*sr*/ false);
  const feats = bidMoveFeatures(bids, includeLiar);
  const scores = await _scoreMoves(obs, feats, bids.length + (includeLiar ? 1 : 0));
  const pick = _argmax(scores);
  if (includeLiar && pick === 0) return { action: 'liar' };
  const idxIntoBids = pick - (includeLiar ? 1 : 0);
  const b = bids[idxIntoBids];
  return { action: 'bid', q: b.q, f: b.f };
}

// ── High-level: the AI's show-reroll decision ─────────────────────
// Returns a Set<number> of hand indices to reveal, or null for skip.
//
// Action space (up to 3 options, in this order):
//   0  skip
//   1  reveal-all-supporters (1s + bid-face dice), reroll the rest
//      — only when 1 ≤ |supporters| < |hidden|
//   2  reveal one non-supporter (the first by hand index), reroll the rest
//      — only when ≥1 non-supporter exists. Useful in the desperate case
//      where the bidder believes the previous bid is correct but no
//      higher bid is, so they raise by exactly one and gamble on a fresh
//      reroll of the rest.
async function policyChooseShowReroll(players, bid, perspectiveIdx) {
  const me = players[perspectiveIdx];
  const hidden = me.dice
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => !d.revealed);
  if (hidden.length < 2) return null;

  const supporters    = hidden.filter(({ d }) => supportsBid(d.face, bid.f));
  const nonSupporters = hidden.filter(({ d }) => !supportsBid(d.face, bid.f));

  const options = [{ kind: 'skip', indices: new Set(), faces: [] }];
  if (supporters.length > 0 && supporters.length < hidden.length) {
    options.push({
      kind:    'all-supporters',
      indices: new Set(supporters.map((s) => s.i)),
      faces:   supporters.map((s) => s.d.face),
    });
  }
  if (nonSupporters.length > 0) {
    const first = nonSupporters[0];
    options.push({
      kind:    'one-non-supporter',
      indices: new Set([first.i]),
      faces:   [first.d.face],
    });
  }
  if (options.length === 1) return null;   // only skip is possible

  // bidderIdx for the obs is the AI itself (just made the bid).
  const obs   = encodeObs(players, perspectiveIdx, bid, perspectiveIdx, /*sr*/ true);
  const feats = showRerollMoveFeatures(options.map((o) => o.faces));
  const scores = await _scoreMoves(obs, feats, options.length);
  const pick = _argmax(scores);
  const chosen = options[pick];
  return chosen.kind === 'skip' ? null : chosen.indices;
}

Object.assign(window, {
  loadPolicy, encodeObs, bidMoveFeatures, showRerollMoveFeatures,
  policyChooseBid, policyChooseShowReroll,
});
