![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)
![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/mannn7/makefun-sokoban/rank.svg)
![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/mannn7/makefun-sokoban/reward.svg)

# Sokoban Solver — push-optimal, room by room

A Node 22 program (`main.ts`) that solves every Sokoban level of a set in as
few pushes as possible.

## How it works

Every level this competition draws is a hallway with one to four rooms off
it, each room holding 3–4 boxes and as many goals — and a box that leaves its
room through the door can never come back. So the rooms are independent
problems joined only by the player's walk, and the level's push optimum is
the sum of the rooms' optima. The solver:

1. cuts the hallway's dead squares out of the floor and takes each remaining
   part that holds a box as a room;
2. solves each room push-optimally with an A* over pushes (each push costs
   1), the other rooms' boxes standing as walls, the player walking on from
   where the last room left it;
3. falls back to a breadth-first search over pushes when the A* gives up,
   and to a search over the whole level when a level is no set of rooms.

The search state is the boxes' squares plus the player's reachable region.
Its estimate is the cheapest assignment of boxes to goals by Manhattan
distance, which no push can beat by more than one per push, so the first
solved state is push-optimal. Two deadlocks are pruned, both safe: a box on
a dead square (found by pulling back from the goals) and a frozen 2×2 block
of walls and boxes. Everything is budgeted by work (states expanded), never
by the clock, so two runs write the same bytes.

## Results

- Practice set: **1,000,000** — all 5 instances solved in exactly P* pushes
  (13, 16, 29, 47, 60), in ~0.4 s for the whole set.
- Four freshly drawn sets (same generator, other seeds): **1,000,000** each,
  every instance at exactly P*, 0.4–0.9 s a set.
- The house baseline (plain-astar) scores **200,000** on the practice set —
  it solves only the first instance.

## Files

- `main.ts` — the solver (Node 22, standard library only).
- `LICENSE` — MIT.
- `AGENT.md` — build notes.
