// bidpanels.jsx — GridPanel only.
// Receives: { players, currentBid, totalDice, history, onCommitBid, disabled }
// `history` is an array of {playerId, q, f}; bid cells are tinted with the
// most recent bidder's color so users can see who bid what.

const { Die, MiniDie, hexA } = window;
const { effective } = window;

function isLegal(q, f, prev) {
  if (q < 1) return false;
  if (!prev) return true;
  return window.bidBeats({ q, f }, prev);
}

function findHistoryFor(history, q, f) {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.q === q && h.f === f) return h;
  }
  return null;
}

function BidLabel({ q, f, color = '#111', q_size = 14, die_size = 13 }) {
  // Bids refer to generic dice, not any one player's, so the face is
  // always white with dark pips — readable on plain or color-tinted cells.
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: q_size, fontWeight: 700, color }}>{q}</span>
      <MiniDie face={f} size={die_size} bg="#fff" pipColor="#111" />
    </span>
  );
}

// Rows indexed by *effective count* e = 1..totalDice.
//   col 1 (face=1): present only when e is even, q = e/2
//   cols 2..6 (faces 2..6): q = e
// Puts 3×1s in the same row as 6×2s, 6×3s, etc.
function GridPanel({ players, currentBid, totalDice, history, onCommitBid, disabled }) {
  // Effective counts up to totalDice cover faces 2–6 (q ≤ totalDice). The
  // 1s column needs to extend to effective = 2 × totalDice so a bid of
  // every-die-is-a-1 (q = totalDice, eff = 2·totalDice) is reachable.
  const rows = [];
  for (let e = 1; e <= totalDice * 2; e++) rows.push(e);

  const scrollerRef = React.useRef(null);
  React.useEffect(() => {
    if (!scrollerRef.current || !currentBid) return;
    const e = effective(currentBid.q, currentBid.f);
    const el = scrollerRef.current.querySelector(`[data-row="${e}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentBid?.q, currentBid?.f]);

  function cellFor(e, f) {
    if (f === 1) {
      if (e % 2 !== 0) return null;
      return { q: e / 2, f: 1 };
    }
    // Faces 2–6: q = e, only meaningful while q ≤ totalDice.
    if (e > totalDice) return null;
    return { q: e, f };
  }

  return (
    <div style={{
      padding: 10, flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
    }}>
      <div ref={scrollerRef} style={{
        flex: 1, minHeight: 0, overflowY: 'auto', borderRadius: 12,
        background: 'rgba(0,0,0,0.025)', padding: 6,
      }}>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4,
        }}>
          {rows.flatMap((e) =>
            [1,2,3,4,5,6].map((f) => {
              const cell = cellFor(e, f);
              if (!cell) {
                return <div key={`${e}-${f}`} data-row={e} style={{ height: 44 }} />;
              }
              const { q } = cell;
              const legal = !disabled && isLegal(q, f, currentBid);
              const hist = findHistoryFor(history, q, f);
              const tone = hist ? players.find((p) => p.id === hist.playerId)?.color : null;
              const labelColor = tone ? '#fff' : '#111';
              return (
                <button
                  key={`${e}-${f}`}
                  data-row={e}
                  onClick={legal ? () => onCommitBid({ q, f }) : undefined}
                  disabled={!legal}
                  style={{
                    position: 'relative',
                    height: 44, borderRadius: 10,
                    background: tone ? tone : '#fff',
                    border: tone ? `1px solid ${tone}` : '1px solid rgba(0,0,0,0.06)',
                    opacity: legal ? 1 : (tone ? 0.85 : 0.32),
                    cursor: legal ? 'pointer' : 'not-allowed',
                    padding: 0,
                    transition: 'transform 100ms, background 120ms',
                  }}
                >
                  <BidLabel q={q} f={f} color={labelColor} q_size={20} die_size={22} />
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function BidPanel(props) { return <GridPanel {...props} />; }

Object.assign(window, { BidPanel });
