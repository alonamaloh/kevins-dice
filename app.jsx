// app.jsx — Top-level Kevin's Dice game.
// State machine:
//   phase: 'roll' → 'bid' → 'challenge' → 'roundEnd' → 'roll' …  → 'gameOver'
// Player turn cycles through .alive players in order, starting from `starterId`.

const { Die, MiniDie, PlayerRow, hexA } = window;
const { effective, bidBeats, legalBids, supportsBid, canShowReroll, resolveChallenge, aiTurn, totalDice } = window;
const { BidPanel } = window;
const { loadPolicy, policyChooseBid, policyChooseShowReroll } = window;
const { playRollSound } = window;

// Player setup: human + 3 AI.
const PLAYERS = [
  { id: 'al',    name: 'Al',    color: '#D88A1F', isHuman: false },
  { id: 'kban',  name: 'K-Ban', color: '#3F8CCB', isHuman: false },
  { id: 'marty', name: 'Marty', color: '#5BA15B', isHuman: false },
  { id: 'you',   name: 'You',   color: '#7A4FB0', isHuman: true  },
];

const STARTING_DICE = 5;

function rollDie() { return Math.floor(Math.random() * 6) + 1; }
function freshHand(n) { return Array.from({ length: n }, () => ({ face: rollDie(), revealed: false })); }
function rerollHidden(dice) {
  return dice.map((d) => d.revealed ? d : { face: rollDie(), revealed: false });
}
function clearAllReveals(dice) { return dice.map((d) => ({ face: d.face, revealed: false })); }

function makeInitialState() {
  return {
    players: PLAYERS.map((p) => ({ ...p, alive: true, dice: freshHand(STARTING_DICE) })),
    turnIdx: 0, // index into players (regardless of alive — we skip dead ones in advance)
    starterId: 'you',
    bid: null,
    history: [], // [{playerId, q, f}]
    selection: [], // indices in YOUR own dice the user has tapped to mark for show-reroll
    phase: 'bid', // 'bid' | 'challenge' | 'roundEnd' | 'gameOver'
    challenge: null, // {actual, threshold, bidderWins, bidderId, challengerId}
    roundLog: [],
  };
}

function nextAlive(players, fromIdx) {
  const n = players.length;
  for (let step = 1; step <= n; step++) {
    const i = (fromIdx + step) % n;
    if (players[i].alive) return i;
  }
  return fromIdx;
}
function indexOfPlayer(players, id) { return players.findIndex((p) => p.id === id); }

// ─────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────
function App() {
  const [state, setState] = React.useState(makeInitialState);
  const stateRef = React.useRef(state);
  React.useEffect(() => { stateRef.current = state; }, [state]);

  const me = state.players.find((p) => p.isHuman);
  const myColor = me.color;
  const currentPlayer = state.players[state.turnIdx];
  const isMyTurn = currentPlayer.isHuman && state.phase === 'bid';

  // Clear the "select blocked" warning after a moment
  React.useEffect(() => {
    if (!state.selectBlockedAt) return;
    const t = setTimeout(() => setState((s) => s.selectBlockedAt ? { ...s, selectBlockedAt: 0 } : s), 1600);
    return () => clearTimeout(t);
  }, [state.selectBlockedAt]);

  // Kick the ONNX session load on mount so the first AI turn isn't
  // blocked behind a fresh download.
  React.useEffect(() => { loadPolicy().catch((e) => console.error(e)); }, []);

  // Round-start clatter: phase is 'bid' AND nobody has bid yet.
  React.useEffect(() => {
    if (state.phase === 'bid' && state.history.length === 0) {
      const total = state.players.reduce(
        (s, p) => s + (p.alive ? p.dice.length : 0), 0);
      playRollSound(total);
    }
  }, [state.phase, state.starterId]);

  // ── AI driver: when it's an AI's turn, compute and apply move after a beat.
  React.useEffect(() => {
    if (state.phase !== 'bid') return;
    const cp = state.players[state.turnIdx];
    if (cp.isHuman) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const cur = stateRef.current;
        const total = totalDice(cur.players);
        const cpIdx = indexOfPlayer(cur.players, cp.id);
        const move = await policyChooseBid(cur.players, cur.bid, cpIdx, cur.history, total);
        if (cancelled) return;
        if (move.action === 'liar') {
          doCallLiar(cp.id);
        } else {
          // Decide show-reroll BEFORE committing — the AI sees the same
          // public state the engine would feed the show-reroll prompt
          // (the new bid is now standing).
          const newBid = { q: move.q, f: move.f };
          const projected = cur.players.map((p) => ({
            ...p, dice: p.dice.map((d) => ({ ...d })),
          }));
          // policyChooseShowReroll expects the current bid; the projection's
          // dice haven't been re-rolled yet, so the AI scores its decision
          // against its actual hand.
          const sr = await policyChooseShowReroll(projected, newBid, cpIdx);
          if (cancelled) return;
          doCommitBid(cp.id, newBid, sr);
        }
      } catch (e) {
        console.error('policy turn failed', e);
      }
    }, 750 + Math.random() * 600);
    return () => { cancelled = true; clearTimeout(t); };
  }, [state.turnIdx, state.phase]);

  // Heuristic: AI does show-reroll only if all its hidden non-supporters are exactly the
  // dice that the new bid count would push it to gamble on.
  function shouldAIShowReroll(player, prevBid, newBid) {
    const hidden = player.dice.filter((d) => !d.revealed);
    const supporters = hidden.filter((d) => supportsBid(d.face, newBid.f));
    if (supporters.length === 0 || supporters.length === hidden.length) return false;
    // Show only if supporters >= 2 and there's at least 1 non-supporter to gamble on.
    return supporters.length >= 2 && Math.random() < 0.4;
  }

  // ── Actions ────────────────────────────────────────────────
  function doCommitBid(playerId, bid, withShowReroll) {
    setState((s) => {
      const players = s.players.map((p) => ({ ...p, dice: p.dice.map((d) => ({ ...d })) }));
      const pIdx = indexOfPlayer(players, playerId);
      const actor = players[pIdx];

      // Show-and-reroll: reveal supporters (or selected), reroll rest of hidden.
      if (withShowReroll) {
        const hidden = actor.dice.map((d, i) => ({ d, i })).filter(({ d }) => !d.revealed);
        let toReveal;
        if (actor.isHuman) {
          // Use selection (already validated as supporters of the *new* bid)
          toReveal = new Set(s.selection);
        } else {
          toReveal = new Set(hidden.filter(({ d }) => supportsBid(d.face, bid.f)).map(({ i }) => i));
        }
        actor.dice = actor.dice.map((d, i) => {
          if (toReveal.has(i)) return { ...d, revealed: true };
          if (!d.revealed) return { face: rollDie(), revealed: false };
          return d;
        });
      }

      const history = [...s.history, { playerId, q: bid.q, f: bid.f }];
      const nextIdx = nextAlive(players, pIdx);
      return {
        ...s, players, history, bid, turnIdx: nextIdx, selection: [],
      };
    });
    // Reroll clatter — count the dice that just got rerolled (= hidden
    // dice not in the reveal set) so the sound matches the action.
    if (withShowReroll) {
      const before = stateRef.current.players.find((p) => p.id === playerId);
      const hiddenIdxs = before.dice
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => !d.revealed)
        .map(({ i }) => i);
      let revealedSet;
      if (before.isHuman) {
        revealedSet = new Set(stateRef.current.selection);
      } else {
        revealedSet = new Set(before.dice
          .map((d, i) => ({ d, i }))
          .filter(({ d, i }) => !d.revealed && supportsBid(d.face, bid.f))
          .map(({ i }) => i));
      }
      const numRerolled = hiddenIdxs.filter((i) => !revealedSet.has(i)).length;
      if (numRerolled > 0) playRollSound(numRerolled);
    }
  }

  function doCallLiar(challengerId) {
    setState((s) => {
      const result = resolveChallenge(s.players, s.bid);
      const bidder = s.history[s.history.length - 1];
      const bidderId = bidder.playerId;
      const isEquality = result.actual === result.threshold;
      // On equality the bidder still "wins" (≥ q), but it's a special
      // transfer: challenger gives one die to bidder.
      const loserId = result.bidderWins ? challengerId : bidderId;
      const winnerId = result.bidderWins ? bidderId : challengerId;
      const lossAmount = isEquality
        ? 1                                             // transfer, not loss
        : Math.abs(result.actual - result.threshold);

      // Reveal everything for the dramatic moment.
      const players = s.players.map((p) => ({
        ...p, dice: p.dice.map((d) => ({ ...d, revealed: true })),
      }));
      return {
        ...s, players, phase: 'roundEnd',
        challenge: {
          ...result, bidderId, challengerId, loserId, winnerId,
          isEquality, lossAmount, bid: s.bid,
        },
      };
    });
  }

  function startNextRound() {
    setState((s) => {
      const players = s.players.map((p) => ({ ...p, dice: p.dice.map((d) => ({ ...d })) }));
      const ch = s.challenge;

      if (ch.isEquality) {
        // Challenger transfers one die to bidder.
        const challenger = players.find((p) => p.id === ch.challengerId);
        const bidder    = players.find((p) => p.id === ch.bidderId);
        if (challenger.dice.length > 0) {
          challenger.dice = challenger.dice.slice(0, challenger.dice.length - 1);
          // The face doesn't matter — every alive player rerolls below —
          // but keep the array shape consistent.
          bidder.dice = [...bidder.dice, { face: rollDie(), revealed: false }];
        }
      } else {
        // Loser loses |actual - threshold| dice (capped at their pool).
        const loser = players.find((p) => p.id === ch.loserId);
        const newSize = Math.max(0, loser.dice.length - ch.lossAmount);
        loser.dice = loser.dice.slice(0, newSize);
      }

      // Eliminate any player at 0 dice.
      players.forEach((p) => { if (p.dice.length === 0) p.alive = false; });

      const aliveCount = players.filter((p) => p.alive).length;
      if (aliveCount <= 1) {
        return { ...s, players, phase: 'gameOver', bid: null, history: [], challenge: s.challenge };
      }

      // Re-roll everyone.
      players.forEach((p) => { if (p.alive) p.dice = freshHand(p.dice.length); });

      // Winner of the challenge starts the next round (always alive,
      // since they didn't lose any dice).
      let starterIdx = indexOfPlayer(players, ch.winnerId);
      if (!players[starterIdx].alive) starterIdx = nextAlive(players, starterIdx);

      return {
        ...s,
        players, phase: 'bid',
        starterId: players[starterIdx].id,
        turnIdx: starterIdx,
        bid: null, history: [], selection: [], challenge: null,
      };
    });
  }

  function newGame() { setState(makeInitialState()); }

  // ── Human helpers ─────────────────────────────────────────
  function toggleSelect(idx) {
    setState((s) => {
      // Block selecting the last hidden die — must always leave ≥1 hidden.
      if (!s.selection.includes(idx)) {
        const me = s.players.find((p) => p.isHuman);
        const hiddenIdxs = me.dice.map((d, i) => ({ d, i })).filter(({ d }) => !d.revealed).map(({ i }) => i);
        if (s.selection.length + 1 >= hiddenIdxs.length) {
          // Refuse — flash the warning hint instead.
          return { ...s, selectBlockedAt: Date.now() };
        }
      }
      const sel = s.selection.includes(idx)
        ? s.selection.filter((i) => i !== idx)
        : [...s.selection, idx];
      return { ...s, selection: sel, selectBlockedAt: 0 };
    });
  }

  // Validate: can the human do show-reroll with the current selection for `bid`?
  // Works for opener bids too (no `state.bid` required).
  function selectionValidForBid(s, bid) {
    if (!bid) return false;
    const me = s.players.find((p) => p.isHuman);
    if (!s.selection.length) return false;
    const hiddenIdxs = me.dice.map((d, i) => ({ d, i })).filter(({ d }) => !d.revealed).map(({ i }) => i);
    if (s.selection.some((i) => !hiddenIdxs.includes(i))) return false;
    if (s.selection.length >= hiddenIdxs.length) return false; // must leave ≥1 hidden
    return s.selection.every((i) => supportsBid(me.dice[i].face, bid.f));
  }

  function humanCommitBid(bid) {
    if (!isMyTurn) return;
    const willShowReroll = selectionValidForBid(state, bid);
    doCommitBid('you', bid, willShowReroll);
  }

  function humanCallLiar() {
    if (!isMyTurn || !state.bid) return;
    doCallLiar('you');
  }

  // ── Render ────────────────────────────────────────────────
  // Order players for display: AI on top in turn order, human on bottom.
  // Reorder as: kevin, mira, jules, you (already that order in PLAYERS).

  const total = totalDice(state.players);

  // Last-bid lookup per player from state.history
  const lastBidByPlayer = {};
  for (const h of state.history) lastBidByPlayer[h.playerId] = { q: h.q, f: h.f };

  const myDraftBid = null; // handled inside panel

  return (
    <div style={{
      height: '100dvh',
      display: 'flex', flexDirection: 'column',
      background: '#F4F1EC', color: '#111',
      overflow: 'hidden',
      paddingTop: 'env(safe-area-inset-top)',
      paddingBottom: 'env(safe-area-inset-bottom)',
      fontFamily: '-apple-system, system-ui, sans-serif',
    }}>
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          background: '#F4F1EC',
          color: '#111',
          minHeight: 0,
        }}>
          {/* Header bar */}
          <div style={{
            padding: '8px 18px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)', fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: 1 }}>Kevin's Dice</div>
              <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.3, marginTop: 1 }}>
                {state.phase === 'gameOver' ? 'Game over' :
                  isMyTurn ? 'Your turn' : `${currentPlayer.name}'s turn`}
              </div>
            </div>
            <button onClick={newGame} style={{
              border: 'none', background: 'rgba(0,0,0,0.05)', borderRadius: 999,
              padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#111',
            }}>New game</button>
          </div>

          {/* Players area — natural height, doesn't grow. Bid panel
              below takes the remaining space. */}
          <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', padding: '6px 10px 0', gap: 2 }}>
            {state.players.filter((p) => !p.isHuman).map((p) => {
              const lastBidder = state.history[state.history.length - 1];
              const isStanding = !!lastBidder && lastBidder.playerId === p.id;
              return (
                <PlayerRow
                  key={p.id}
                  player={p}
                  isYou={false}
                  isActive={state.players[state.turnIdx]?.id === p.id && state.phase === 'bid'}
                  lastBid={lastBidByPlayer[p.id] || null}
                  revealAll={state.phase === 'roundEnd' || state.phase === 'gameOver'}
                  dieSize={36}
                  isStandingBid={isStanding && isMyTurn}
                  onChallenge={isStanding && isMyTurn ? humanCallLiar : undefined}
                />
              );
            })}

            {/* Round result banner */}
            {(state.phase === 'roundEnd' || state.phase === 'gameOver') && (
              <ChallengeBanner state={state} />
            )}

            {/* Your row — same style as opponents, no big separator */}
            <PlayerRow
              player={me}
              isYou={true}
              isActive={isMyTurn}
              lastBid={lastBidByPlayer['you'] || null}
              revealAll={state.phase === 'roundEnd' || state.phase === 'gameOver'}
              selection={state.selection}
              onToggleSelect={isMyTurn ? toggleSelect : undefined}
              dieSize={36}
            />
            {/* Show-reroll hint */}
            {isMyTurn && (
              <div style={{
                margin: '4px 14px 6px', padding: '8px 12px', borderRadius: 10,
                fontSize: 16, lineHeight: 1.3,
                color: state.selectBlockedAt ? '#A35200' : 'rgba(0,0,0,0.7)',
                background: state.selectBlockedAt ? 'rgba(250,204,21,0.22)'
                  : state.selection.length ? hexA(myColor, 0.08) : 'transparent',
                fontWeight: state.selectBlockedAt ? 600 : 500,
                transition: 'background 200ms, color 200ms',
              }}>
                {state.selectBlockedAt ? (
                  <>You have to keep at least one die hidden.</>
                ) : state.selection.length ? (
                  <>Showing {state.selection.length} die{state.selection.length === 1 ? '' : 'ce'} on bid — reroll the rest after committing.</>
                ) : state.bid ? (
                  <>Tap your dice to mark them for show-and-reroll, then raise.</>
                ) : (
                  <>You're opening this round. Tap dice to show on your opening bid, then pick one below.</>
                )}
              </div>
            )}
          </div>

          {/* Bid panel */}
          {state.phase === 'bid' && (
            <div style={{
              borderTop: '1px solid rgba(0,0,0,0.06)',
              background: '#fff',
              flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
            }}>
              <BidPanel
                players={state.players}
                currentBid={state.bid}
                totalDice={total}
                history={state.history}
                onCommitBid={humanCommitBid}
                myColor={myColor}
                disabled={!isMyTurn}
              />
            </div>
          )}
          {(state.phase === 'roundEnd' || state.phase === 'gameOver') && (
            <div style={{
              borderTop: '1px solid rgba(0,0,0,0.06)', padding: 16, background: '#fff',
            }}>
              {state.phase === 'gameOver' ? (
                <button onClick={newGame} style={primaryBtnStyle}>New game</button>
              ) : (
                <button onClick={startNextRound} style={primaryBtnStyle}>Next round →</button>
              )}
            </div>
          )}
        </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
        @keyframes pop { from { transform: scale(0.9); opacity: 0; } to { transform: none; opacity: 1; } }
      `}</style>
    </div>
  );
}

function ChallengeBanner({ state }) {
  const ch = state.challenge;
  if (!ch) return null;
  const bidder = PLAYERS.find((p) => p.id === ch.bidderId);
  const challenger = PLAYERS.find((p) => p.id === ch.challengerId);
  const loser = PLAYERS.find((p) => p.id === ch.loserId);
  const verb = (p, plural, sing) => p.isHuman ? plural : sing;
  let outcome;
  if (ch.isEquality) {
    outcome = `${challenger.name} ${verb(challenger, 'give', 'gives')} a die to ${bidder.name}`;
  } else {
    const n = ch.lossAmount;
    outcome = `${loser.name} ${verb(loser, 'lose', 'loses')} ${n} ${n === 1 ? 'die' : 'dice'}`;
  }
  return (
    <div style={{
      margin: '6px 14px', padding: '10px 14px', borderRadius: 14,
      background: '#111', color: '#fff', animation: 'pop 220ms',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ fontSize: 11, opacity: 0.6, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase' }}>
        {challenger.name} called liar on {bidder.name}'s {ch.bid.q}× {faceGlyph(ch.bid.f)}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: -0.2 }}>
        {ch.actual} actual · needed {ch.threshold} → {outcome}
        {state.phase === 'gameOver' ? (() => {
          const w = state.players.find((p) => p.alive);
          return w ? ` · ${w.name} ${w.isHuman ? 'win' : 'wins'}!` : '';
        })() : ''}
      </div>
    </div>
  );
}

function faceGlyph(f) { return ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][f]; }

const primaryBtnStyle = {
  width: '100%', height: 48, borderRadius: 12, border: 'none',
  background: '#111', color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer',
};

// Mount
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
