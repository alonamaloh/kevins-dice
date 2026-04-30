// dice.jsx — Die glyph + PlayerRow.
// Classic pip dice tinted with each player's color band.

// Pip layouts (3x3 grid; 1 = pip). Face 1 is rendered as a five-pointed
// star elsewhere — Kevin's Dice 1s are wild, and there's a real published
// Liar's Dice set whose 1 face has a star rather than a single pip.
const DICE_PIPS = {
  1: [[0,0,0],[0,0,0],[0,0,0]],
  2: [[1,0,0],[0,0,0],[0,0,1]],
  3: [[1,0,0],[0,1,0],[0,0,1]],
  4: [[1,0,1],[0,0,0],[1,0,1]],
  5: [[1,0,1],[0,1,0],[1,0,1]],
  6: [[1,0,1],[1,0,1],[1,0,1]],
};

// Regular five-pointed star, viewBox 0 0 100 100, point up.
// Pre-computed: outer radius 48, inner radius 18.34, centered at (50,50).
const STAR_POINTS =
  '50,2 60.78,35.17 95.65,35.17 67.44,55.67 78.21,88.83 ' +
  '50,68.34 21.79,88.83 32.56,55.67 4.35,35.17 39.22,35.17';

function StarGlyph({ size, color }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size}
         style={{ display: 'block' }} aria-hidden="true">
      <polygon points={STAR_POINTS} fill={color} />
    </svg>
  );
}

// Single die. `face`=1..6 or null (hidden). `tone` = player's color.
// `size` = px. `state`: 'normal' | 'selected' | 'revealedPublic' | 'just-rolled' | 'dim'
// `rolledAt` is a millisecond timestamp; when it changes to a value within
// the last ROLL_MS, the die runs a brief tumble animation (flicker through
// random faces for visible dice, wobble the "?" for hidden dice).
const ROLL_MS = 520;
function Die({ face, tone = '#111', size = 36, state = 'normal', onClick, ariaLabel, rolledAt }) {
  const known = face != null;
  const isSelected = state === 'selected';
  const isPublic = state === 'revealedPublic';
  const isDim = state === 'dim';

  const [rolling, setRolling] = React.useState(false);
  const [flickerFace, setFlickerFace] = React.useState(face || 1);
  const [hiddenAngle, setHiddenAngle] = React.useState(0);

  React.useEffect(() => {
    if (rolledAt == null) return;
    const elapsed = Date.now() - rolledAt;
    if (elapsed >= ROLL_MS) return;
    setRolling(true);
    const tick = setInterval(() => {
      setFlickerFace(Math.floor(Math.random() * 6) + 1);
      // Snap the hidden "?" to one of four cardinal orientations.
      setHiddenAngle([0, 90, 180, 270][Math.floor(Math.random() * 4)]);
    }, 70);
    const stop = setTimeout(() => {
      clearInterval(tick);
      setRolling(false);
      setHiddenAngle(0);
    }, ROLL_MS - elapsed);
    return () => { clearInterval(tick); clearTimeout(stop); };
  }, [rolledAt]);

  // Solid-color die in player tone, white pips. Hidden = tinted-tone face
  // with a "?" glyph (still on-brand to the player).
  let bg = tone;
  let pipColor = '#fff';
  let border = '1px solid rgba(0,0,0,0.06)';
  let shadow = '0 1px 0 rgba(255,255,255,0.18) inset, 0 2px 6px rgba(0,0,0,0.10)';
  let opacity = 1;

  if (!known) {
    // hidden: pale tone with ? glyph
    bg = hexA(tone, 0.14);
    pipColor = tone;
    border = `1px dashed ${hexA(tone, 0.45)}`;
    shadow = 'none';
  }
  if (isSelected) {
    // selected for show-reroll — bright yellow outline so it pops on any tone
    shadow = `0 0 0 3px #FACC15, 0 0 0 5px rgba(250,204,21,0.35), 0 4px 10px rgba(0,0,0,0.14)`;
  }
  if (isPublic) {
    // revealed publicly mid-round: solid tone with subtle ring
    shadow = `0 0 0 2px ${hexA(tone, 0.20)}, 0 2px 6px rgba(0,0,0,0.10)`;
  }
  if (isDim) opacity = 0.35;

  const r = Math.round(size * 0.22);
  const pipSize = Math.max(3, Math.round(size * 0.18));
  const displayFace = rolling && known ? flickerFace : face;
  const tilt = rolling ? 'rotate(-8deg) scale(0.94)' : 'rotate(0deg) scale(1)';

  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      aria-label={ariaLabel}
      style={{
        width: size, height: size, borderRadius: r,
        background: bg, border, boxShadow: shadow,
        padding: 0, opacity, cursor: onClick ? 'pointer' : 'default',
        position: 'relative',
        transition: 'transform .25s cubic-bezier(.2,.8,.2,1), box-shadow 120ms, background 120ms',
        transform: tilt,
      }}
    >
      {known ? (
        displayFace === 1 ? (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <StarGlyph size={Math.round(size * 0.68)} color={pipColor} />
          </div>
        ) : (
          <DiceFace pips={DICE_PIPS[displayFace]} pipSize={pipSize} pipColor={pipColor} size={size} />
        )
      ) : (
        <span style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: tone, fontWeight: 600, fontSize: Math.round(size * 0.5),
          fontFamily: '-apple-system, system-ui, sans-serif',
          transform: `rotate(${hiddenAngle}deg)`,
        }}>?</span>
      )}
    </button>
  );
}

function DiceFace({ pips, pipSize, pipColor, size }) {
  const pad = Math.round(size * 0.18);
  const cells = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    cells.push(
      <span key={`${r}-${c}`} style={{
        width: pipSize, height: pipSize, borderRadius: '50%',
        background: pips[r][c] ? pipColor : 'transparent',
        gridRow: r + 1, gridColumn: c + 1, alignSelf: 'center', justifySelf: 'center',
      }} />
    );
  }
  return (
    <div style={{
      position: 'absolute', inset: pad, display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: '1fr 1fr 1fr',
    }}>{cells}</div>
  );
}

// Tiny inline die used in bid labels and bid history pills.
// Tiny inline die used in bid labels and bid history pills.
// `color` = the surrounding label color (used as die outline).
// `bg` and `pipColor` default to a white face + colored pips, but can be flipped
// for "inverted" contexts (e.g. on a saturated colored chip, pass bg=color, pipColor='#fff').
function MiniDie({ face, color = '#111', size = 14, bg = '#fff', pipColor }) {
  const pips = DICE_PIPS[face];
  const pad = Math.round(size * 0.18);
  const ps = Math.max(2, Math.round(size * 0.18));
  const pip = pipColor || color;
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: Math.round(size * 0.22),
      background: bg, border: `1px solid ${hexA(color, 0.35)}`, position: 'relative', verticalAlign: '-3px',
    }}>
      {face === 1 ? (
        <span style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <StarGlyph size={Math.round(size * 0.72)} color={pip} />
        </span>
      ) : (
        <span style={{
          position: 'absolute', inset: pad, display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: '1fr 1fr 1fr',
        }}>
          {pips.flat().map((on, i) => (
            <span key={i} style={{
              width: ps, height: ps, borderRadius: '50%', alignSelf: 'center', justifySelf: 'center',
              background: on ? pip : 'transparent',
            }} />
          ))}
        </span>
      )}
    </span>
  );
}

// One opponent / self row.
// `revealAll` shows everyone's dice (challenge phase).
// `selectable` makes own hidden dice tappable (for show-and-reroll).
function PlayerRow({
  player, isYou, isActive, isLastBidder, lastBid, revealAll,
  selection = [], onToggleSelect,
  dieSize = 30, lostDie,
  isStandingBid = false, onChallenge,
}) {
  const tone = player.color;
  const showAll = revealAll || isYou;
  const dim = !player.alive;

  // Split dice into revealed (visible to all, sit ABOVE the active highlight)
  // and hidden (inside the row's highlight). Only do this for YOU — for other
  // players we keep the row compact and show every die in one line.
  const splitRevealed = isYou && !revealAll && player.dice.some((d) => d.revealed);
  const revealedDice = splitRevealed ? player.dice.map((d, i) => ({ d, i })).filter(({ d }) => d.revealed) : [];
  const mainDice = splitRevealed ? player.dice.map((d, i) => ({ d, i })).filter(({ d }) => !d.revealed) : player.dice.map((d, i) => ({ d, i }));

  function renderDie({ d, i }) {
    const visible = showAll || d.revealed;
    const isSelected = selection.includes(i);
    const canTap = isYou && onToggleSelect && !d.revealed;
    let state = 'normal';
    if (isSelected) state = 'selected';
    else if (d.revealed && !revealAll) state = 'revealedPublic';
    if (lostDie && lostDie.playerId === player.id && lostDie.idx === i) state = 'dim';
    return (
      <Die
        key={i}
        face={visible ? d.face : null}
        tone={tone}
        size={dieSize}
        state={state}
        rolledAt={d.rolledAt}
        onClick={canTap ? () => onToggleSelect(i) : undefined}
        ariaLabel={visible ? `die ${d.face}` : 'hidden die'}
      />
    );
  }

  return (
    <div style={{
      padding: '0 14px',
      opacity: dim ? 0.4 : 1,
    }}>
      {/* Revealed dice float ABOVE the active highlight */}
      {revealedDice.length > 0 && (
        <div style={{
          display: 'flex', gap: 6, padding: '4px 0 2px 0',
          minHeight: dieSize,
        }}>
          {revealedDice.map(renderDie)}
        </div>
      )}

      {/* Active-row pill: hidden dice + bid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        alignItems: 'center',
        gap: 10,
        padding: '8px 0',
        borderRadius: 14,
        background: isActive ? 'rgba(0,0,0,0.04)' : 'transparent',
        transition: 'background 200ms',
        margin: revealedDice.length > 0 ? '0 -8px' : '0',
        paddingLeft: revealedDice.length > 0 ? 8 : 0,
        paddingRight: revealedDice.length > 0 ? 8 : 0,
      }}>
        {/* Dice (single row, no wrap) */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'nowrap', minWidth: 0 }}>
          {mainDice.map(renderDie)}
          {!player.alive && (
            <span style={{
              fontSize: 11, color: 'rgba(0,0,0,0.5)', fontWeight: 500,
              padding: '4px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.05)',
            }}>out</span>
          )}
        </div>

      {/* Last bid pill — same shape on every row. Standing-bid rows show a
          tappable "Challenge" label underneath that runs onChallenge. */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        gap: 5, minWidth: 0, textAlign: 'right', fontSize: 20,
      }}>
        {lastBid ? (
          <span
            onClick={isStandingBid && onChallenge ? onChallenge : undefined}
            role={isStandingBid && onChallenge ? 'button' : undefined}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '5px 11px', borderRadius: 999,
              background: tone, color: '#fff', fontWeight: 700,
              cursor: isStandingBid && onChallenge ? 'pointer' : 'default',
              userSelect: 'none',
              boxShadow: isStandingBid && onChallenge ? `0 0 0 2px ${hexA(tone, 0.30)}` : 'none',
            }}>
            {lastBid.q} <MiniDie face={lastBid.f} color={tone} size={22} bg="#fff" pipColor="#111" />
          </span>
        ) : null}
        {isStandingBid && onChallenge ? (
          <button
            onClick={onChallenge}
            style={{
              background: 'transparent', border: 'none', padding: '2px 4px',
              cursor: 'pointer', color: '#111',
              fontSize: 12, fontWeight: 700, letterSpacing: 0.2,
              textTransform: 'uppercase',
            }}
          >Challenge</button>
        ) : null}
      </div>
      </div>
    </div>
  );
}

// helpers
function hexA(hex, a) {
  // accepts #rgb or #rrggbb
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

Object.assign(window, { Die, MiniDie, PlayerRow, DICE_PIPS, hexA });
