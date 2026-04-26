# Kevin's Dice

A web mockup of **Kevin's Dice**, a Liar's Dice variant. Play one human seat
against three AI opponents driven by a small policy network trained
end-to-end via self-play.

Live: <https://alonamaloh.github.io/kevins-dice/>

## Rules

You and N − 1 opponents each start with 5 dice (six-sided, faces 1–6). Each
round, all alive players secretly roll. The round-starting player makes an
**opening bid** — a quantity and a face, e.g. "five 3s" — and play passes
clockwise. Each subsequent player either **raises the bid** (must be strictly
greater under the ordering below) or **calls liar** on the standing bid.

When liar is called, all dice are revealed and the bid is scored:

- The bid `q × f` is satisfied if at least `q` dice show face `f`.
- **1s are wild** — they count as `f` whenever `f ≠ 1`. (When the bid face
  *is* 1, only literal 1s count.)
- The amount that changes hands is `|actual − q|`:
  - If `actual > q`, the **challenger** loses `actual − q` dice (gone, not
    transferred).
  - If `actual < q`, the **bidder** loses `q − actual` dice.
  - If `actual == q` exactly, the **challenger transfers one die** to the
    bidder.
- A player at zero dice is eliminated. Last player standing wins.
- The **winner of the challenge** opens the next round.

### Bid ordering

Each bid has an **effective count**: `q × 2` if the face is 1, else just `q`.
A new bid must be strictly greater than the previous on `(effective, face)`,
lexicographically. For example:

- `5 × 1s` (effective 10) **beats** `9 × 6s` (effective 9).
- `5 × 1s` (effective 10) **loses to** `10 × 2s` (effective 10, face 2 > 1).

### Show-and-reroll

After making a bid, the bidder may optionally take one **show-and-reroll**
action: reveal one or more of their hidden "supporting" dice (literal 1s, plus
literal copies of the bid face) and reroll all of their other hidden dice.
Revealed dice stay public for the rest of the round and still count at
challenge time. You must reveal at least one die and leave at least one
hidden.

It's a commitment device — you've made a bid that's a bit of a stretch, so
you lock in the supporting dice you actually have (giving opponents hard
information) and gamble on the reroll for additional matches.

In this build the AI is restricted to the simpler binary choice of *skip* vs
*reveal-all-supporters*; the human seat retains the full flexibility of
arbitrary subsets. Tap your dice to mark them for show-and-reroll, then pick
a bid in the grid below.

## Tech

- **Pure-static SPA**: no backend, no build step. React + Babel-standalone
  transpile JSX in the browser; everything runs from a handful of `.jsx`
  files plus one `.onnx` model.
- **Policy network (`policy.onnx`)**: a small ~50 KB feed-forward net trained
  on 8 M episodes of self-play with PPO (4 epochs per chunk, entropy
  coefficient 0.03). The "8M" snapshot was the strongest in a round-robin
  tournament across all checkpoints from 6M onward.
- **Inference**: [`onnxruntime-web`](https://github.com/microsoft/onnxruntime)
  in single-threaded WASM mode (no SharedArrayBuffer / COOP-COEP needed).
- **Sound**: dice-clatter sound effects synthesized live with the Web Audio
  API — no audio assets to ship.
- **Action-space mismatch**: the AI only learned the simplified
  show-and-reroll, so its read of "human revealed exactly 2 of 3 supporters"
  is slightly off-distribution. In practice the public state still tells the
  AI everything it needs.

## Credits

- The **Kevin's Dice** rules variant comes from Alvaro's friend Kevin —
  hence the name.
- The original UI mockup was sketched in
  [Claude Design](https://claude.ai/design); the React + state-machine
  scaffolding survived the policy integration almost unchanged.
- The training engine, policy net, and self-play pipeline live in a separate
  C++/Python project (not part of this static deploy).
