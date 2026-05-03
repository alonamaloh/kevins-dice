// policy.jsx — drives AI seats with the ONNX-exported KevinsDiceNet.
//
// Mirrors `python/general_games/policies/kevins_dice.py`:
//   * `encodeObs`       ↔ `encode(snap, n, is_show_reroll_phase)`
//   * `bidMoveFeatures` ↔ `_bid_move_features`
//   * `showRerollMoveFeatures` ↔ `_show_reroll_move_features`
//   * `actionLogToSlots` + `slotsToWindow` ↔ KD agent's `on_event` +
//     `encode_with_action_window` (window-net variant).
//
// The exported graph (gui/policy.onnx) takes (obs[obs_dim],
// move_features[n,9]) and returns scores[n]; we argmax to pick a move.
// `obs_dim` is auto-detected from the loaded ONNX model: a window-net
// snapshot has obs_dim = base_dim + window_size * ACTION_FEAT_DIM, where
// base_dim is fixed by num_players.
//
// All exported helpers are stuck on `window` so app.jsx can reach them.

const NUM_FACES = 6;
const MOVE_FEAT_DIM = 9;
// Per-turn slot layout (10 dims) — must mirror kevins_dice.py exactly.
//   [0]   is_bid
//   [1]   is_challenge
//   [2]   q_norm        (bid or challenged-bid quantity, /STARTING_DICE*n)
//   [3]   f_norm        (face / NUM_FACES)
//   [4]   eff_norm      (q*2 if face=1 else q, normalized)
//   [5]   did_show_reroll
//   [6]   n_revealed_norm
//   [7]   n_ones_revealed_norm
//   [8]   n_face_revealed_norm
//   [9]   bid_was_bluff (challenge only)
// Actor identity is implicit in slot position under strict cycle
// alignment: slot at offset -k from window end == player k cycle
// positions to the agent's right (or no-op if that position was
// skipped).
const ACTION_FEAT_DIM = 10;
const STARTING_DICE = 5;

// Match the WASM bundle to the umd script tag in Kevin's Dice.html.
ort.env.wasm.wasmPaths =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
// Single-threaded WASM avoids needing COOP/COEP headers for
// SharedArrayBuffer; the model is tiny so threading wouldn't help anyway.
ort.env.wasm.numThreads = 1;

let _session = null;
let _sessionPromise = null;
// Auto-detected at load time from the model's `obs` input dim. 0 means
// "Markov baseline" (no action window); >0 means window-net with this
// many slots. Set by `loadPolicy` before any inference call returns.
let _windowSize = 0;

function _detectWindowSize(session, numPlayers) {
  // ORT-web exposes input shapes via session.inputMetadata['<name>'].dimensions.
  // Numeric dims come back as numbers; symbolic dims as strings ("n_moves").
  // The `obs` input is always fully concrete.
  const meta = session.inputMetadata && session.inputMetadata.obs;
  if (!meta || !Array.isArray(meta.dimensions) || meta.dimensions.length !== 1) {
    return 0;
  }
  const obsDim = Number(meta.dimensions[0]);
  const baseDim = 6 + 6 + 1 + (numPlayers - 1) * 8 + 6 + 1; // mirror _obs_dim
  const extra = obsDim - baseDim;
  if (extra <= 0) return 0;
  if (extra % ACTION_FEAT_DIM !== 0) {
    console.warn('policy.jsx: obs_dim', obsDim,
      'incompatible with base', baseDim, '+ k*', ACTION_FEAT_DIM,
      '— falling back to window=0');
    return 0;
  }
  return extra / ACTION_FEAT_DIM;
}

function loadPolicy(path = 'policy.onnx', numPlayers = 4) {
  if (_session) return Promise.resolve(_session);
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = ort.InferenceSession.create(path, {
    executionProviders: ['wasm'],
  }).then((s) => {
    _session = s;
    _windowSize = _detectWindowSize(s, numPlayers);
    return s;
  });
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

function encodeObs(players, perspectiveIdx, currentBid, bidderIdx,
                   isShowRerollPhase, actionLog = null) {
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
  // + others_block ((n-1)*8) + bid_block (6) + phase (1) + (window-net)
  // sliding-window of past actions (window_size * ACTION_FEAT_DIM).
  const baseDim = 6 + 6 + 1 + (n - 1) * 8 + 6 + 1;
  const obsDim = baseDim + _windowSize * ACTION_FEAT_DIM;
  const obs = new Float32Array(obsDim);
  let o = 0;
  obs.set(hiddenHist, o);   o += 6;
  obs.set(revealedHist, o); o += 6;
  obs[o++] = myDice.length;
  for (const b of otherBlocks) { obs.set(b, o); o += 8; }
  obs.set(bidBlock, o); o += 6;
  obs[o++] = isShowRerollPhase ? 1.0 : 0.0;
  if (_windowSize > 0) {
    // Walk cycle to self for bid prompts; leave alone for show-reroll
    // prompts (the agent's own bid is the most recent slot, intentionally).
    const walk = !isShowRerollPhase;
    const slots = actionLog ? actionLogToSlots(actionLog, me, n, walk) : [];
    obs.set(slotsToWindow(slots, _windowSize), o);
  }
  return obs;
}

// ── Action-slot encoding (strict positional, mirrors kevins_dice.py) ──

function _qNorm(q, n) { return Number(q) / (STARTING_DICE * n); }
function _fNorm(f)    { return Number(f) / NUM_FACES; }

function encodeBidSlot(q, f, n) {
  const slot = new Float32Array(ACTION_FEAT_DIM);
  slot[0] = 1.0;             // is_bid
  slot[2] = _qNorm(q, n);
  slot[3] = _fNorm(f);
  const eff = Number(f) === 1 ? Number(q) * 2 : Number(q);
  slot[4] = _qNorm(eff, n);
  return slot;
}

// Mutate a freshly-appended bid slot to fold in the bidder's show-reroll
// outcome (this is an intra-turn extra by the same actor — doesn't add a
// new slot to the cycle stream).
function addShowRerollToSlot(slot, revealedFaces, currentBidFace) {
  slot[5] = 1.0;             // did_show_reroll
  const nRev = revealedFaces.length;
  let nOnes = 0, nFace = 0;
  const bf = currentBidFace == null ? null : Number(currentBidFace);
  for (const f of revealedFaces) {
    const v = Number(f);
    if (v === 1) nOnes++;
    if (bf != null && bf !== 1 && v === bf) nFace++;
  }
  slot[6] = nRev  / STARTING_DICE;
  slot[7] = nOnes / STARTING_DICE;
  slot[8] = nFace / STARTING_DICE;
}

function encodeChallengeSlot(challengedQ, challengedF, actualCount, n) {
  const slot = new Float32Array(ACTION_FEAT_DIM);
  slot[1] = 1.0;             // is_challenge
  slot[2] = _qNorm(challengedQ, n);
  slot[3] = _fNorm(challengedF);
  const eff = Number(challengedF) === 1 ? Number(challengedQ) * 2 : Number(challengedQ);
  slot[4] = _qNorm(eff, n);
  slot[9] = Number(actualCount) < Number(challengedQ) ? 1.0 : 0.0;
  return slot;
}

// Walk an action log (chronological list of bid / show-reroll / challenge
// entries, with `actorIdx` 0-indexed) and produce the cycle-aligned slot
// array. Mirrors `_KDAgentBase.on_event` in kevins_dice.py:
//   * Within a round, every turn (bid, challenge, or skipped position)
//     advances the cursor by exactly 1.
//   * Show-reroll is folded into the just-appended bid slot — no new slot.
//   * On challenge, the round ends: the slot stream is wiped and the
//     cursor reset (bids from previous rounds don't carry over).
//   * `walkToPerspective`: at the agent's own bid prompt, walk the cursor
//     forward to the agent's seat so the slot at offset -1 from the
//     window end is "1 turn ago = right-neighbor of self."
function actionLogToSlots(actionLog, perspectiveIdx, numPlayers, walkToPerspective) {
  let slots = [];
  let cyclePos = 0;
  let seenEvent = false;
  let currentBidFace = null;

  function emitNoopsTo(target) {
    if (!seenEvent) {
      cyclePos = target;
      seenEvent = true;
      return;
    }
    let pos = cyclePos;
    while (pos !== target) {
      slots.push(new Float32Array(ACTION_FEAT_DIM));
      pos = (pos + 1) % numPlayers;
    }
  }

  for (const e of actionLog) {
    if (e.type === 'bid') {
      emitNoopsTo(e.actorIdx);
      slots.push(encodeBidSlot(e.q, e.f, numPlayers));
      currentBidFace = e.f;
      cyclePos = (e.actorIdx + 1) % numPlayers;
    } else if (e.type === 'show-reroll') {
      if (slots.length > 0) {
        addShowRerollToSlot(slots[slots.length - 1],
                            e.revealedFaces, currentBidFace);
      }
    } else if (e.type === 'challenge') {
      // Round ends — wipe the stream. Per-round semantics: bids from
      // the just-finished round don't influence the next round's window.
      slots = [];
      cyclePos = 0;
      seenEvent = false;
      currentBidFace = null;
    }
    // 'eliminated' entries are ignored — eliminated players show up
    // as no-op runs in the cycle naturally.
  }

  // For bid prompts: walk the cursor forward to the perspective so the
  // window's "1 turn ago" slot lines up with the right-neighbor. For
  // show-reroll prompts the caller passes walkToPerspective=false (the
  // last slot is the agent's own bid; the is_show_reroll_phase flag
  // disambiguates).
  if (walkToPerspective) {
    emitNoopsTo(perspectiveIdx);
  }

  return slots;
}

// Take the last `windowSize` slots (left-pad with zeros if fewer have
// accumulated) and flatten into a single Float32Array of length
// windowSize * ACTION_FEAT_DIM.
function slotsToWindow(slots, windowSize) {
  const out = new Float32Array(windowSize * ACTION_FEAT_DIM);
  if (windowSize <= 0 || slots.length === 0) return out;
  const recent = slots.slice(-windowSize);
  const offset = (windowSize - recent.length) * ACTION_FEAT_DIM;
  for (let i = 0; i < recent.length; i++) {
    out.set(recent[i], offset + i * ACTION_FEAT_DIM);
  }
  return out;
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
async function policyChooseBid(players, currentBid, perspectiveIdx, history,
                               totalDice, actionLog = null) {
  // Enumerate legal bids; include "call liar" iff there's a standing bid.
  const bids = legalBids(currentBid, totalDice);
  const includeLiar = !!currentBid;
  const bidderIdx = currentBid && history.length
    ? players.findIndex((p) => p.id === history[history.length - 1].playerId)
    : null;
  const obs = encodeObs(players, perspectiveIdx, currentBid, bidderIdx,
                        /*sr*/ false, actionLog);
  const feats = bidMoveFeatures(bids, includeLiar);
  const scores = await _scoreMoves(obs, feats, bids.length + (includeLiar ? 1 : 0));
  const pick = _argmax(scores);
  if (includeLiar && pick === 0) return { action: 'liar' };
  const idxIntoBids = pick - (includeLiar ? 1 : 0);
  const b = bids[idxIntoBids];
  return { action: 'bid', q: b.q, f: b.f };
}

// ── High-level: the AI's show-reroll decision ─────────────────────
// Binary choice: skip vs reveal-and-reroll. The reveal set is fixed by
// the position:
//   • If the bidder has any supporting hidden dice (1s or bid-face),
//     reveal *all* of them and reroll the rest.
//   • Otherwise (no supporters at all — the desperate case where the
//     bidder is raising by one on faith), reveal a single non-supporter
//     (the first by hand index) and reroll the rest.
// The action is illegal when every hidden die is a supporter (nothing
// to reroll) or when fewer than 2 dice are hidden.
//
// Returns a Set<number> of hand indices to reveal, or null for skip.
async function policyChooseShowReroll(players, bid, perspectiveIdx,
                                      actionLog = null) {
  const me = players[perspectiveIdx];
  const hidden = me.dice
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => !d.revealed);
  if (hidden.length < 2) return null;

  const supporters = hidden.filter(({ d }) => supportsBid(d.face, bid.f));
  if (supporters.length === hidden.length) return null;   // all supporters → no reroll possible

  let revealIndices, revealFaces;
  if (supporters.length > 0) {
    revealIndices = new Set(supporters.map((s) => s.i));
    revealFaces   = supporters.map((s) => s.d.face);
  } else {
    // No supporters: sacrifice the first hidden die to keep the action
    // available.
    const first = hidden[0];
    revealIndices = new Set([first.i]);
    revealFaces   = [first.d.face];
  }

  const obs   = encodeObs(players, perspectiveIdx, bid, perspectiveIdx,
                          /*sr*/ true, actionLog);
  const feats = showRerollMoveFeatures([[], revealFaces]);   // [skip, reveal]
  const scores = await _scoreMoves(obs, feats, 2);
  return _argmax(scores) === 1 ? revealIndices : null;
}

Object.assign(window, {
  loadPolicy, encodeObs, bidMoveFeatures, showRerollMoveFeatures,
  policyChooseBid, policyChooseShowReroll,
  // Action-window helpers exposed for inspection/testing.
  encodeBidSlot, encodeChallengeSlot, addShowRerollToSlot,
  actionLogToSlots, slotsToWindow,
});
