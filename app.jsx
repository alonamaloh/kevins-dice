// app.jsx — Top-level Kevin's Dice game.
// State machine:
//   phase: 'roll' → 'bid' → 'challenge' → 'roundEnd' → 'roll' …  → 'gameOver'
// Player turn cycles through .alive players in order, starting from `starterId`.

const { Die, MiniDie, PlayerRow, hexA } = window;
const { effective, bidBeats, legalBids, supportsBid, canShowReroll, resolveChallenge, aiTurn, totalDice } = window;
const { BidPanel } = window;
const { loadPolicy, policyChooseBid, policyChooseShowReroll } = window;
const { playRollSound, unlockAudio } = window;

// Player setup: human + 3 AI.
const PLAYERS = [
  { id: 'al',    name: 'Al',    color: '#CB3F3F', isHuman: false },
  { id: 'kban',  name: 'K-Ban', color: '#3F8CCB', isHuman: false },
  { id: 'marty', name: 'Marty', color: '#5BA15B', isHuman: false },
  { id: 'you',   name: 'You',   color: '#7A4FB0', isHuman: true  },
];

const STARTING_DICE = 5;

function rollDie() { return Math.floor(Math.random() * 6) + 1; }
// `rolledAt` timestamps freshly-rolled dice so the <Die> component can
// run a brief flicker+tilt animation when the value changes. Pre-game
// (splash) dice carry `rolledAt: 0` so they sit still until the first
// real roll stamps them.
function freshHand(n, rolledAt = Date.now()) {
  return Array.from({ length: n }, () => ({ face: rollDie(), revealed: false, rolledAt }));
}
function rerollHidden(dice) {
  const t = Date.now();
  return dice.map((d) => d.revealed ? d : { face: rollDie(), revealed: false, rolledAt: t });
}
function clearAllReveals(dice) { return dice.map((d) => ({ face: d.face, revealed: false, rolledAt: d.rolledAt })); }

function makeInitialState({ splash = false } = {}) {
  // Random opening seat — keeps the human from always going first.
  const startIdx = Math.floor(Math.random() * PLAYERS.length);
  // On the splash screen suppress the roll animation: pass rolledAt=0 so
  // the dice render statically until the player actually starts the game.
  const initialRolledAt = splash ? 0 : Date.now();
  return {
    players: PLAYERS.map((p) => ({ ...p, alive: true, dice: freshHand(STARTING_DICE, initialRolledAt) })),
    turnIdx: startIdx,
    starterId: PLAYERS[startIdx].id,
    bid: null,
    history: [], // [{playerId, q, f}] — current-round bids only; reset each round
    // Persistent across rounds; mirror of the Python policy's event stream.
    // Entries are one of:
    //   {type: 'bid',         actorIdx, q, f}
    //   {type: 'show-reroll', actorIdx, revealedFaces}
    //   {type: 'challenge',   actorIdx, challengedQ, challengedF, actualCount}
    //   {type: 'eliminated',  actorIdx}
    // The window-net policy walks this log to build its sliding-window
    // observation. Independent of the per-round `history`.
    actionLog: [],
    selection: [], // indices in YOUR own dice the user has tapped to mark for show-reroll
    // 'splash' is the first-load gate (lets us collect a user gesture
    // before any audio plays). 'bid' | 'roundEnd' | 'gameOver' are the
    // gameplay states.
    phase: splash ? 'splash' : 'bid',
    challenge: null,
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
// Orientation hook — landscape when window is wider than tall.
// ─────────────────────────────────────────────────────────────
function useIsLandscape() {
  const get = () => typeof window !== 'undefined' && window.innerWidth > window.innerHeight;
  const [v, setV] = React.useState(get);
  React.useEffect(() => {
    const onResize = () => setV(get());
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return v;
}

// ─────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────
function App() {
  const [state, setState] = React.useState(() => makeInitialState({ splash: true }));
  const stateRef = React.useRef(state);
  React.useEffect(() => { stateRef.current = state; }, [state]);

  const isLandscape = useIsLandscape();

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

  // Auto-advance round-end when the human is out: spectating doesn't
  // benefit from manual pacing. Brief pause so the result is readable.
  React.useEffect(() => {
    if (state.phase !== 'roundEnd') return;
    const human = state.players.find((p) => p.isHuman);
    if (human && human.alive) return;
    const t = setTimeout(() => startNextRound(), 1000);
    return () => clearTimeout(t);
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
        const move = await policyChooseBid(cur.players, cur.bid, cpIdx,
                                            cur.history, total, cur.actionLog);
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
          // For the show-reroll decision the AI sees the just-committed bid
          // already in the log, so append a synthetic bid entry to the log
          // we pass in. We don't mutate state.actionLog here — that happens
          // in doCommitBid once the move is actually applied.
          const projLog = [...cur.actionLog,
            { type: 'bid', actorIdx: cpIdx, q: newBid.q, f: newBid.f }];
          const sr = await policyChooseShowReroll(projected, newBid, cpIdx, projLog);
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
  // `revealHandIndices` is a Set<number> of hand indices to reveal (empty
  // / null means no show-and-reroll). Both human and AI paths now build
  // it before calling.
  function doCommitBid(playerId, bid, revealHandIndices) {
    const willReveal = !!(revealHandIndices && revealHandIndices.size > 0);
    setState((s) => {
      const players = s.players.map((p) => ({ ...p, dice: p.dice.map((d) => ({ ...d })) }));
      const pIdx = indexOfPlayer(players, playerId);
      const actor = players[pIdx];

      // Capture the revealed faces *before* mutating actor.dice, so the
      // log records the actual revealed faces (not the post-reroll ones).
      const revealedFaces = willReveal
        ? actor.dice.filter((d, i) => revealHandIndices.has(i)).map((d) => d.face)
        : null;

      if (willReveal) {
        const t = Date.now();
        actor.dice = actor.dice.map((d, i) => {
          if (revealHandIndices.has(i)) return { ...d, revealed: true };
          if (!d.revealed) return { face: rollDie(), revealed: false, rolledAt: t };
          return d;
        });
      }

      const history = [...s.history, { playerId, q: bid.q, f: bid.f }];
      const actionLog = [...s.actionLog,
        { type: 'bid', actorIdx: pIdx, q: bid.q, f: bid.f }];
      if (willReveal) {
        actionLog.push({ type: 'show-reroll', actorIdx: pIdx, revealedFaces });
      }
      const nextIdx = nextAlive(players, pIdx);
      return {
        ...s, players, history, actionLog, bid, turnIdx: nextIdx, selection: [],
      };
    });
    // Reroll clatter — rerolled count = (hidden dice before) - (revealed).
    if (willReveal) {
      const before = stateRef.current.players.find((p) => p.id === playerId);
      const hiddenCount = before.dice.filter((d) => !d.revealed).length;
      const numRerolled = hiddenCount - revealHandIndices.size;
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
      const challengerIdx = indexOfPlayer(s.players, challengerId);
      const actionLog = [...s.actionLog, {
        type: 'challenge', actorIdx: challengerIdx,
        challengedQ: s.bid.q, challengedF: s.bid.f,
        actualCount: result.actual,
      }];
      return {
        ...s, players, actionLog, phase: 'roundEnd',
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
          bidder.dice = [...bidder.dice, { face: rollDie(), revealed: false, rolledAt: Date.now() }];
        }
      } else {
        // Loser loses |actual - threshold| dice (capped at their pool).
        const loser = players.find((p) => p.id === ch.loserId);
        const newSize = Math.max(0, loser.dice.length - ch.lossAmount);
        loser.dice = loser.dice.slice(0, newSize);
      }

      // Eliminate any player at 0 dice. Append elimination entries to
      // the persistent action log so the policy's window-builder advances
      // its alive vector at the right point in time.
      const newlyEliminated = [];
      players.forEach((p, i) => {
        if (p.dice.length === 0 && p.alive) {
          p.alive = false;
          newlyEliminated.push(i);
        }
      });
      const actionLog = newlyEliminated.length
        ? [...s.actionLog, ...newlyEliminated.map((i) =>
            ({ type: 'eliminated', actorIdx: i }))]
        : s.actionLog;

      const aliveCount = players.filter((p) => p.alive).length;
      if (aliveCount <= 1) {
        return { ...s, players, actionLog, phase: 'gameOver',
                 bid: null, history: [], challenge: s.challenge };
      }

      // Re-roll everyone.
      players.forEach((p) => { if (p.alive) p.dice = freshHand(p.dice.length); });

      // Winner of the challenge starts the next round (always alive,
      // since they didn't lose any dice).
      let starterIdx = indexOfPlayer(players, ch.winnerId);
      if (!players[starterIdx].alive) starterIdx = nextAlive(players, starterIdx);

      return {
        ...s,
        players, actionLog, phase: 'bid',
        starterId: players[starterIdx].id,
        turnIdx: starterIdx,
        bid: null, history: [], selection: [], challenge: null,
      };
    });
  }

  function newGame() { setState(makeInitialState()); }
  async function startFromSplash() {
    // Unlock audio while we still have a verifiable user gesture, and
    // wait for the AudioContext to be running before kicking off the
    // round (its very first event is the dice-roll clatter).
    await unlockAudio();
    setState((s) => {
      // Stamp every die with rolledAt=now so the splash transition
      // triggers the same flicker+tilt as a normal round-start roll.
      const t = Date.now();
      const players = s.players.map((p) => ({
        ...p, dice: p.dice.map((d) => ({ ...d, rolledAt: t })),
      }));
      return { ...s, players, phase: 'bid' };
    });
  }

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
  // Works for opener bids too (no `state.bid` required). The selected dice
  // do NOT have to support the bid — any hidden dice may be shown, as long
  // as ≥1 die stays hidden.
  function selectionValidForBid(s, bid) {
    if (!bid) return false;
    const me = s.players.find((p) => p.isHuman);
    if (!s.selection.length) return false;
    const hiddenIdxs = me.dice.map((d, i) => ({ d, i })).filter(({ d }) => !d.revealed).map(({ i }) => i);
    if (s.selection.some((i) => !hiddenIdxs.includes(i))) return false;
    if (s.selection.length >= hiddenIdxs.length) return false; // must leave ≥1 hidden
    return true;
  }

  function humanCommitBid(bid) {
    if (!isMyTurn) return;
    const reveal = selectionValidForBid(state, bid)
      ? new Set(state.selection)
      : null;
    doCommitBid('you', bid, reveal);
  }

  function humanCallLiar() {
    if (!isMyTurn || !state.bid) return;
    doCallLiar('you');
  }

  // ── Render ────────────────────────────────────────────────
  if (state.phase === 'splash') {
    return <SplashScreen onStart={startFromSplash} isLandscape={isLandscape} />;
  }

  const total = totalDice(state.players);

  // Last-bid lookup per player from state.history
  const lastBidByPlayer = {};
  for (const h of state.history) lastBidByPlayer[h.playerId] = { q: h.q, f: h.f };

  // ── Reusable blocks (rendered identically in portrait & landscape) ──
  const headerEl = (
    <div style={{
      padding: '8px 18px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      flexShrink: 0,
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
  );

  const opponentRows = state.players.filter((p) => !p.isHuman).map((p) => {
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
  });

  const yourRow = (
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
  );

  const banner = (state.phase === 'roundEnd' || state.phase === 'gameOver') && (
    <ChallengeBanner state={state} />
  );

  const hint = isMyTurn && (
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
  );

  const bidPanelEl = state.phase === 'bid' && (
    <BidPanel
      players={state.players}
      currentBid={state.bid}
      totalDice={total}
      history={state.history}
      onCommitBid={humanCommitBid}
      myColor={myColor}
      disabled={!isMyTurn}
    />
  );

  const actionBtnEl = (state.phase === 'roundEnd' || state.phase === 'gameOver') && (
    state.phase === 'gameOver'
      ? <button onClick={newGame} style={primaryBtnStyle}>New game</button>
      : <button onClick={startNextRound} style={primaryBtnStyle}>Next round →</button>
  );

  const playersBlock = (
    <>
      {opponentRows}
      {banner}
      {yourRow}
      {hint}
    </>
  );

  const pageStyle = {
    height: '100dvh',
    display: 'flex', flexDirection: 'column',
    background: '#F4F1EC', color: '#111',
    overflow: 'hidden',
    paddingTop: 'env(safe-area-inset-top)',
    paddingBottom: 'env(safe-area-inset-bottom)',
    fontFamily: '-apple-system, system-ui, sans-serif',
  };

  if (isLandscape) {
    return (
      <div style={pageStyle}>
        {headerEl}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* LEFT: dice + last bids */}
          <div style={{
            flex: 1, minWidth: 0, minHeight: 0,
            display: 'flex', flexDirection: 'column',
            padding: '4px 10px 0', gap: 2, overflow: 'auto',
          }}>
            {playersBlock}
          </div>
          {/* RIGHT: bid panel / round-end action */}
          <div style={{
            width: 'min(46%, 420px)', flexShrink: 0,
            display: 'flex', flexDirection: 'column', minHeight: 0,
            borderLeft: '1px solid rgba(0,0,0,0.06)',
            background: '#fff',
          }}>
            {bidPanelEl && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {bidPanelEl}
              </div>
            )}
            {actionBtnEl && (
              <div style={{ padding: 16, marginTop: 'auto' }}>{actionBtnEl}</div>
            )}
          </div>
        </div>
        <style>{`
          @keyframes fadeIn { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
          @keyframes pop { from { transform: scale(0.9); opacity: 0; } to { transform: none; opacity: 1; } }
        `}</style>
      </div>
    );
  }

  // Portrait
  return (
    <div style={pageStyle}>
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        background: '#F4F1EC', color: '#111', minHeight: 0,
      }}>
        {headerEl}
        <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', padding: '6px 10px 0', gap: 2 }}>
          {playersBlock}
        </div>
        {bidPanelEl && (
          <div style={{
            borderTop: '1px solid rgba(0,0,0,0.06)',
            background: '#fff',
            flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
          }}>
            {bidPanelEl}
          </div>
        )}
        {actionBtnEl && (
          <div style={{
            borderTop: '1px solid rgba(0,0,0,0.06)', padding: 16, background: '#fff',
          }}>
            {actionBtnEl}
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

function SplashScreen({ onStart, isLandscape }) {
  // Render the beige background immediately, but keep the title +
  // photo + button hidden until the dice photo has finished loading.
  // Then fade them in together so the page never flashes a half-loaded
  // image.
  const [ready, setReady] = React.useState(false);
  // Safety net: if the image somehow never fires onLoad (cached error
  // path, blocked, etc.) reveal the splash anyway after a short delay.
  React.useEffect(() => {
    const t = setTimeout(() => setReady(true), 1500);
    return () => clearTimeout(t);
  }, []);

  const photoMask = {
    WebkitMaskImage: 'radial-gradient(ellipse 70% 70% at 50% 45%, #000 55%, transparent 100%)',
    maskImage:       'radial-gradient(ellipse 70% 70% at 50% 45%, #000 55%, transparent 100%)',
  };

  if (isLandscape) {
    return (
      <div style={{
        height: '100dvh', display: 'flex', flexDirection: 'row',
        background: '#F2EFE9', color: '#111',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        fontFamily: '-apple-system, system-ui, sans-serif',
        opacity: ready ? 1 : 0,
        transition: 'opacity 220ms ease-out',
        overflow: 'hidden',
      }}>
        {/* LEFT — dice photo */}
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '24px 12px 24px 24px', minWidth: 0,
        }}>
          <img
            src="kevins_dice_image.png"
            alt="Four colorful dice"
            onLoad={() => setReady(true)}
            style={{
              maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto',
              display: 'block',
              ...photoMask,
            }}
          />
        </div>
        {/* RIGHT — title + Start button */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 24, padding: '24px 32px',
        }}>
          <div style={{ fontSize: 40, fontWeight: 700, color: '#111', textAlign: 'center' }}>
            Kevin's Dice
          </div>
          <button
            onClick={onStart}
            style={{
              padding: '14px 36px', borderRadius: 14,
              border: 'none', background: '#111', color: '#fff',
              fontSize: 18, fontWeight: 700, cursor: 'pointer',
            }}
          >Start game</button>
        </div>
      </div>
    );
  }

  // Portrait
  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 24,
      background: '#F2EFE9', color: '#111',
      paddingTop: 'env(safe-area-inset-top)',
      paddingBottom: 'env(safe-area-inset-bottom)',
      fontFamily: '-apple-system, system-ui, sans-serif',
      opacity: ready ? 1 : 0,
      transition: 'opacity 220ms ease-out',
    }}>
      <div style={{ fontSize: 32, fontWeight: 700, color: '#111' }}>
        Kevin's Dice
      </div>
      <img
        src="kevins_dice_image.png"
        alt="Four colorful dice"
        onLoad={() => setReady(true)}
        style={{
          width: '70%', maxWidth: 320, height: 'auto',
          ...photoMask,
        }}
      />
      <button
        onClick={onStart}
        style={{
          padding: '14px 36px', borderRadius: 14,
          border: 'none', background: '#111', color: '#fff',
          fontSize: 18, fontWeight: 700, cursor: 'pointer',
        }}
      >Start game</button>
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
      <div style={{ fontSize: 11, opacity: 0.6, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase',
                     display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <span>{challenger.name} called liar on {bidder.name}'s {ch.bid.q}×</span>
        <MiniDie face={ch.bid.f} color="#fff" bg="transparent" pipColor="#fff" size={14} />
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

const primaryBtnStyle = {
  width: '100%', height: 48, borderRadius: 12, border: 'none',
  background: '#111', color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer',
};

// Mount
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
