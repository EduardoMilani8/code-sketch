---
name: code-sketch
description: Explain code by drawing it - turns a function, class, module, call flow or architecture into an editable Excalidraw diagram (plus a PNG preview) that a person can open, tweak and share. Use this whenever the user asks to explain, understand, walk through, visualize, map or "draw" some code, how a feature or request flows, how modules relate, or mentions Excalidraw, a diagram, a flowchart or a whiteboard sketch of code - even if they do not name this skill. Also use it proactively when a text explanation of control flow or architecture would take more than a few paragraphs.
---

# code-sketch

Goal: help someone **understand code** by giving them one small, correct, good-looking Excalidraw diagram plus a short walkthrough. A diagram that is big, tangled or merely decorative defeats that goal, so this skill is built around keeping it small.

You never write Excalidraw JSON by hand. You write a tiny **spec** (nodes, edges, groups); `scripts/sketch.mjs` does layout, sizing, arrow binding, size guardrails and renders a PNG so you can **look at the result before showing it**.

## Workflow

1. **Pin the question.** Write one sentence the diagram must answer ("How does a hit become a level-up?"). This becomes `takeaway`. If you cannot state it, you are not ready to draw.
2. **Read just enough code** to answer that question. Note `file:line` for every node you will draw; those references are what lets the reader jump from the picture back to the code.
3. **Prove every arrow.** An arrow is a claim about the code, and the script cannot check it, so you do. For each arrow, find the line where that call, event, `await` or handoff actually happens and put it in the edge's `at` (`"GameSession.cs:314"`; if the call and its target are in different files, `"caller.py:81 → callee.py:266"`). Direction matters: the arrow starts at whoever *performs* the call or sends the data. If you cannot find the line, either drop the arrow or keep it with `"unsure": true`; it is then drawn dashed with a "?" so the reader knows it is your reading, not the code's. The build warns about arrows that have neither.
4. **Choose what to show** (see "Keeping it small"). Aim for 5-8 nodes; the script refuses more than 12.
5. **Write the spec** to a scratch file (JSON, format below). Write labels and takeaway in the user's language; keep code identifiers verbatim.
6. **Build:** `node <skill-dir>/scripts/sketch.mjs spec.json --out ./diagrams`
   (first run installs two small npm packages by itself; needs Node 18+.)
   If it exits with an error, read the message: it says how to shrink the diagram. Do the shrinking. Text-length errors just need shorter words. `--no-limits` renders a preview of a rejected spec so you can *see* what is wrong; never deliver that one.
7. **Look at it.** Open the PNG with the Read tool and run the checklist below. Fix the spec and rebuild; builds the script refuses do not count; once you have looked at a PNG, rebuild at most twice, then deliver the best version and say what is imperfect.
8. **Deliver:** give the `.excalidraw` path (and say it opens at excalidraw.com via Open/drag-and-drop, or in the VS Code "Excalidraw" extension), then a walkthrough in chat: about 6-10 lines following the numbered arrows, each pointing at `file:line`. Mention what you deliberately left out, and say which arrows (if any) are `unsure`. The build output lists every arrow with its proof line; reuse it for the `file:line` references. The walkthrough matters as much as the picture.

## Spec format

```json
{
  "title": "Short title",
  "takeaway": "One sentence: the thing to remember.",
  "insight": "Optional: a non-obvious fact the arrows do not show.",
  "direction": "auto",
  "numbered": true,
  "groups": [{ "id": "g1", "label": "GameSession.cs" }],
  "nodes": [
    { "id": "a", "label": "HitEnemy", "sub": "GameSession.cs:308", "kind": "process", "group": "g1", "focus": true }
  ],
  "edges": [{ "from": "a", "to": "b", "label": "morreu", "at": "GameSession.cs:321" }]
}
```

| Field | Notes |
|---|---|
| `takeaway` / `insight` | `takeaway` answers the question in one grey line under the title. `insight` is optional and goes in a yellow note in the picture: use it for what the arrows *cannot* show or even suggest the opposite of ("the subtitle file arrives once; afterwards only clock anchors travel"). Use only names that are visible in the picture, and do not repeat the takeaway. If the arrows already tell the story, skip it. |
| `direction` | `auto` (default): tries several layouts and keeps the most compact one that fits. A plain chain becomes a "snake" (rows alternating direction). Leave it on auto unless you have a reason; `LR` / `TB` force one. |
| `numbered` | `true` (default) prefixes arrow labels `1.`, `2.`… in edge order: use for execution/data flow, so the edge order **is** the story. Set `false` for static structure. |
| `kind` | `entry` (green: where it starts), `process` (blue, default), `data` (purple: state/DB/config/object), `module` (teal: another module/assembly/package of this same project), `external` (grey dashed: outside this codebase: engine, API, user), `decision` (yellow diamond: a branch the reader must notice). |
| `sub` | Small second line: `file:line` or a 3-6 word role. Max 56 chars; this is also where "which file" goes. |
| `focus` | Orange thick border. Give it to the one node the reader must remember. |
| `group` | Dashed box around nodes that form **one consecutive stretch of the flow** (a phase: "setup", "per frame", "on death"). It is not "same file": two methods of one file used at different moments go in different phases, with the file in each `sub`. The script warns when members are not linked to each other. |

Edge fields: `label` (what travels or why), `at` (file:line proving the arrow), `unsure` (dashed with "?", for inferred arrows), `dashed` (optional/async), `both` (one two-headed arrow instead of A→B plus B→A, e.g. "schedule / refresh").

Edge order matters when `numbered` is on: list edges in the order things happen.

## Keeping it small (the guardrails)

The script enforces: ≤ 12 nodes, ≤ 14 arrows, ≤ 4 groups, ≤ 3 arrows leaving one node, ≤ 2 crossings, labels ≤ 28 chars, arrow labels ≤ 28, `sub` ≤ 56, `title` ≤ 60, `takeaway` ≤ 120, `insight` ≤ 150, at most 2 forks/loops combined, canvas ≤ 2200 px. These limits are the point, not an obstacle: past that, the picture stops being understood at a glance. When you hit one, shrink with these moves, in this order:

1. **Narrow the question.** One diagram answers one question. A big topic becomes an *overview* (one node per module, ≤ 8) plus separate *zoom-in* diagrams for the parts the reader asks about. Offer the zoom-ins instead of cramming them in.
2. **Collapse.** Merge helpers into one node and list them in `sub` ("ArcSlash, Orbit, Aura…"). A data lookup that is just a step belongs in the `sub` of the node that does it, not in its own node + arrow.
3. **Spend fewer arrows.** An arrow is for something that *happens* (call, data handoff, event). Use a `group` for "belongs together", `sub` for "uses", a `kind` for "what it is". Never draw arrows for imports, inheritance chains or getters unless that is the question. Avoid back-edges/loops unless the loop is the point (label it "repete").
4. **Drop the irrelevant:** logging, DTOs, utils, null checks, error paths (mention them in the walkthrough if they matter).

Prefer one clean spine with a few side branches over a web.

Patterns that come up in real code:

- **Setup once + loop per frame:** number setup as steps 1-2 and the loop as 3-N, with a label like "1x, no início" on the setup arrow; give each phase its own `group`.
- **Call that returns a value:** draw only the forward arrow and say what comes back in its label ("sorteia → posição"). A return arrow doubles the arrows and reads as a loop.
- **Threads, processes, runtimes:** one `group` per lane (Firefox / HTTP thread / UI thread). Show the handoff object (queue, channel, socket) as a `data` node between lanes and label the arrow with what crosses ("event", "POST /event"). Do not draw a lane for something that is not a stretch of the flow.
- **Fan-out (goroutines, workers, promises):** one node plus a group labelled "per replica (goroutine ×30)", not 30 arrows. Say the number in the label.
- **Callbacks, props, event handlers, middleware:** draw them in the order they *run*, and put where they are registered in `sub` ("mounted in index.ts:91"). Do not chain a middleware to a route as if the route called it.
- **Round trip (client → server → client):** make the response handler its own step ("onSaved → refetch"), usually a second phase. Do not close it with a return arrow from the database; the response leaves the route.
- **A loop that *is* the story (timers, event loops, polling):** between two nodes, one two-headed arrow (`both`) labelled "schedule / timeout"; through three or more nodes, one `dashed` back-arrow labelled with its trigger. More than one loop means you are drawing the wrong level.
- **Queues and pulls:** a queue is read by its consumer, but data flows queue → consumer. Make the queue the entry node of the next diagram (`sub`: "filled by the HTTP thread") and draw the arrow in the data direction; do not draw consumer → queue pulls.
- **Side effects:** fold a DB write, log line or cache fill into the `sub` of the node that does it ("upserts reviews · :161") instead of a node plus a fork. A fork mid-flow is the most common reason a diagram turns into a tall strip.
- **The same lane twice:** two groups may share a label ("main goroutine" before and after the fan-out).
- **Split diagrams:** begin part 2 with the node where part 1 ended (same label, `sub`: "continues part 1") so the reader can stitch them.
- **Groups:** a group around one or two nodes rarely earns its box; use it for a real boundary (thread, process, network, persistence).
- **Plain chain with no branch, no boundary and no loop** is a list. If a numbered list in chat would explain it as well, say so, or add the interesting boundary (thread, process, network, persistence) as a `group` so the picture adds something.
- **Names:** drop package/namespace prefixes in labels (`Load`, not `scenario.Load`), put `file:line` in `sub`; for two places, `a.ts:10, :40`.
- **Same source feeding several nodes:** make it a `data` node and let one arrow leave it, rather than one arrow per consumer.

## Where a picture misleads (real examples)

Arrows imply "A calls B". Code often does something else, so check these before trusting your own diagram:

- **Middleware vs. route.** In an Express app, `authenticate` is mounted once in `index.ts:91` and runs before every route. Drawing `authenticate → PUT /reviews` reads as "the route calls auth". Put the mount point in `sub` ("mounted in index.ts:91") and keep the arrow's `at` on that line.
- **Who answers.** After a database write, the HTTP response leaves the *route handler*, not the table. An arrow `table → client` is false even though the data came from the table.
- **Callbacks and props.** `onSaved={handleSaved}` is passed down and called later by the child. The arrow goes from the child that calls it to the handler, and `at` points at the call, not at the place it was passed.
- **Data vs. calls.** The subtitle file arrives once and afterwards only clock anchors are sent. Arrows suggest every hop carries the subtitle. That is what `insight` is for.

If an arrow could be read two ways, rename its label to say what travels ("200 { review }") or mark it `unsure`.

## Look-at-the-PNG checklist

- Can you read the story left-to-right / top-to-bottom by following the numbers, without the walkthrough?
- Is the `focus` node the thing the takeaway is about?
- Any arrow cutting through a group it does not belong to, or crossing another arrow? (the script prints warnings; the picture confirms)
- Any label that says nothing (`calls`, `uses`)? Make it say *what* travels or *why*.
- Would removing any node leave the explanation intact? Then remove it.

The PNG is a plain-font preview; the `.excalidraw` file renders in Excalidraw's hand-drawn style, with arrows bound to their boxes so the user can drag boxes around.

## More

- `references/examples/` has two complete specs (a numbered flow with a group, and a structure diagram). Copy their shape.
- The output file is named after the spec file; pass `--name hit-to-levelup` to choose it (and `--out` for the folder, relative or absolute). Use a descriptive name: the user will keep these files.
- `node scripts/sketch.mjs --help` lists options (`--out`, `--name`, `--no-png`).
