# Sokoban solver — build notes

## Approach

The levels are a hallway plus 1–4 rooms (3–4 boxes each). A box that leaves
its room can never return, so each room is an independent push-optimal
problem and the level optimum is the sum of the rooms' optima. The solver
decomposes the level into rooms (cut the hallway's dead squares, take the
connected parts that hold boxes) and solves each room with A* over pushes:
state = boxes + player's reachable region, estimate = cheapest
box-to-goal assignment by Manhattan distance (admissible, so the first
solved state popped is push-optimal). Pruning: dead squares (pull-back from
goals) and frozen 2x2 blocks. Fallbacks: breadth-first search over pushes
when A* gives up; whole-level search when a level is no set of rooms.
Budgets are by work, never by the clock (deterministic output).

## Verification (local, kit's own scorer + generator)

- Practice set: score 1,000,000 — i001 13/13, i002 16/16, i003 29/29,
  i004 47/47, i005 60/60 pushes (all exactly P*), ~0.4 s, deterministic
  (two runs byte-identical).
- Four freshly generated sets (seeds alpha/beta/gamma/delta, same
  generator): 1,000,000 each, every instance at exactly P*, 0.4–0.9 s a set.
- House baseline plain-astar on the practice set: 200,000 (solves i001 only).

## Limits

- Node 22, standard library only; no network, no clock reads, no randomness.
- Repository: main.ts + LICENSE + README.md + AGENT.md, well under 1 MiB.
- One risk to know: the final set is drawn from the same generator, so the
  room structure is guaranteed — but if a room ever exhausted both searches,
  that instance would score 0 (empty solution) while the other four still
  score. It never happened in 25 tested instances.
