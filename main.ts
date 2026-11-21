// Sokoban solver: push-optimal, room by room.
//
// Idea: every level this competition draws is a hallway with one to four rooms
// off it, each room holding 3-4 boxes and as many goals, and a box that leaves
// its room through the door can never come back. So the rooms are independent
// problems joined only by the player's walk, and the level's push optimum is
// the sum of the rooms' optima. We solve each room on its own with an A*
// over pushes (each push costs 1), then walk the player on to the next room.
//
// The search state is the boxes' squares plus the player's reachable region
// (named by its lowest square): the player walks freely inside a region, so
// only pushes change the state. The estimate is the cheapest assignment of
// boxes to goals by Manhattan distance, which no push can beat by more than
// one per push, so the first solved state the search pops is push-optimal.
// Two deadlocks are pruned, both safe (they never cut a solvable state):
//   - a box on a dead square: one from which no push, ignoring the other
//     boxes, can ever bring it onto a goal (found by pulling back from the
//     goals over open floor);
//   - a frozen 2x2 block of walls and boxes holding a box off its goal.
// A breadth-first search over pushes with the same pruning is kept as a
// fallback. Everything is budgeted by work (states expanded), never by the
// clock, so two runs write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room search expands before it gives up. */
const ROOM_BUDGET = 250_000;
/** The most states the whole run expands across all its rooms and levels. */
const RUN_BUDGET = 2_500_000;

const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text: # wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares a box can stand on and still be pushed onto some goal, ignoring the other boxes. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      // A box on y pushes onto x when the player can stand on y - d.
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The squares the player reaches from `from` with `occupied` boxes in the way; returns the lowest. */
function reach(
  level: Level, occupied: Uint8Array, from: number,
  seen: Int32Array, stamp: number, stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed onto `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return ''; // Unreachable: the caller only asks for reachable squares.
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** A state's key: its boxes and its region's lowest square. */
function keyOf(boxes: number[], low: number): string {
  return `${low}:${boxes.join(',')}`;
}

/** The cheapest assignment of boxes to goals by Manhattan distance (exact for few boxes, a sum of minima else). */
function estimate(w: number, boxes: number[], goals: number[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  const dist = (b: number, g: number): number => Math.abs((g % w) - (b % w)) + Math.abs(Math.floor(g / w) - Math.floor(b / w));
  if (n <= 5) {
    // Every permutation of the goals, cheapest first assignment wins.
    const perm = goals.slice(0, n);
    let best = Infinity;
    const walk = (i: number, used: number, sum: number): void => {
      if (sum >= best) return;
      if (i === n) {
        best = sum;
        return;
      }
      for (let j = 0; j < n; j++) {
        if (used & (1 << j)) continue;
        walk(i + 1, used | (1 << j), sum + dist(boxes[i]!, perm[j]!));
      }
    };
    walk(0, 0, 0);
    return best;
  }
  let sum = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (const g of goals) m = Math.min(m, dist(b, g));
    sum += m;
  }
  return sum;
}

interface SearchResult {
  pushes: number;
  moves: string;
}

/**
 * The push-optimal solution of `level`: {pushes, moves} (moves in LURD, an upper letter a push), or null when the
 * search gives up. A* when `astar` is true (estimate guides it, still optimal: the estimate never overstates the
 * pushes left), plain breadth-first over pushes otherwise. `spent` caps the run's total work: the search stops
 * expanding once the run has spent its budget.
 */
function solvePush(level: Level, astar: boolean, budget: number, spent: { n: number }): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;

  // The states in the order found: their boxes, the player's square after the push that made them, and the push.
  const statesBoxes: number[][] = [level.boxes];
  const statesPlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const gScore: number[] = [0];
  const best = new Map<string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  best.set(keyOf(level.boxes, reach(level, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  // The open list: a heap on (f, deeper g first, then the order found) for A*, a queue for breadth-first.
  const heap: [number, number, number, number][] = []; // [f, -g, seq, state]
  let seq = 0;
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  const queue: number[] = [0];
  let head = 0;
  heapPush([estimate(w, level.boxes, goals), 0, seq++, 0]);

  let found = -1;
  let expanded = 0;
  while ((astar ? heap.length > 0 : head < queue.length) && expanded < budget && spent.n < RUN_BUDGET) {
    const s = astar ? heapPop()[3] : queue[head++]!;
    const boxes = statesBoxes[s]!;
    const g = gScore[s]!;
    expanded++;
    spent.n++;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, statesPlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        // The player must reach the square behind the box, and the box must land on open, live floor.
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        let key = '';
        let next: number[] | null = null;
        if (!frozenBlock(level, occupied, goal, t)) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (next === null) continue;
        const old = best.get(key);
        if (old !== undefined && gScore[old]! <= g + 1) continue;
        const t2 = statesBoxes.length;
        best.set(key, t2);
        statesBoxes.push(next);
        statesPlayer.push(b);
        parent.push(s);
        gScore.push(g + 1);
        if (solved(next)) {
          found = t2;
          break;
        }
        if (astar) heapPush([g + 1 + estimate(w, next, goals), -(g + 1), seq++, t2]);
        else queue.push(t2);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there reaches no goal) out of the
 * floor, and each part left that holds a box is a room. Null when the level is no set of rooms (a box starts in the
 * hallway, a goal is cut off, or a room's boxes and goals mismatch).
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve one room push-optimally: A* first, breadth-first over pushes when it gives up. */
function solveRoom(sub: Level, spent: { n: number }): SearchResult | null {
  return solvePush(sub, true, ROOM_BUDGET, spent) ?? solvePush(sub, false, ROOM_BUDGET, spent);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn, the other rooms' boxes standing as walls
 * (on their goals once their room is done), the player walking on from where the last room left it. A box never leaves
 * its room, so the rooms' optima add up to the level's. Falls back to a search over the whole level when the level is
 * no set of rooms.
 */
function solveLevel(level: Level, spent: { n: number }): SearchResult | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePush(level, true, ROOM_BUDGET, spent) ?? solvePush(level, false, ROOM_BUDGET, spent);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solveRoom(sub, spent);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

const spent = { n: 0 };
for (const id of readdirSync(I).sort()) {
  const text = readFileSync(join(I, id, 'level.txt'), 'utf8');
  const solved = solveLevel(parseLevel(text), spent);
  const moves = solved === null ? '' : solved.moves;
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
