# Professor Viva — Resumable Validation State Machine (Step 8 of gap-closure plan)
**Companion docs:** 02-Architecture (§2.2, §3)

---

## 1. Principle

The Layer-1 validator is a **deterministic five-stage state machine**; each
stage persists its output before the next begins, so a crashed or interrupted
run **resumes** from where it stopped rather than restarting (Architecture §3).
`lib/pipeline.js` wires the four post-intake stages (Steps 3–7) into one
resumable runner.

```
intake ──▶ evidence ──▶ scoring ──▶ verdict ──▶ delivery
 (1)        (2)          (3)         (4)         (5)
```

## 2. The cursor

`ideas.status` **is** the resume cursor. Its ordered values are the number of
completed stages:

| status | completed stages | next stage |
|---|---|---|
| `intake` | 0 | evidence |
| `evidence_gathering` | 1 | scoring |
| `scoring` | 2 | verdict |
| `verdict` | 3 | delivery |
| `complete` | 4 | — (terminal) |

The runner writes the cursor **only after** a stage's output has persisted. A
crash mid-stage leaves the cursor untouched, so that stage re-runs cleanly on
the next call — the "persist before advancing" guarantee (Architecture §2.2 /
§3).

## 3. Stages (single source of truth)

Each stage function composes the already-tested primitives from Steps 3–7 and
writes only its own table output; the runner owns the cursor:

- **evidence** → `gatherAllEvidence` + `insertEvidence`
- **scoring** → `computeScores` + `insertScores` (pure code)
- **verdict** → `computeScores` + `determineVerdict` + `insertVerdict` (pure code)
- **delivery** → guardrail-wrapped voice pass + `updateVerdictVoice`

`runDeliveryStage` is shared: both `POST /ideas/:id/voice` (manual single-stage
trigger, does *not* advance to `complete`) and the full runner use it, so the
guardrail-wrapped voice pass has one implementation. The **verdict card**
(Step 9) folds into this same delivery stage later.

## 4. Endpoint

`POST /ideas/:id/run` executes `runPipeline`, which reads the cursor, skips
already-completed stages, runs the rest, and returns `{ status, resumed_from,
trace }`. The `trace` marks each stage `ran: true|false` so the resume behavior
is observable. Running a `complete` idea is an idempotent no-op.

`planResume(status)` is the **pure** planner (no I/O) behind the runner —
given a cursor it returns `{ toSkip, toRun }` — which is what makes the resume
logic hermetically testable.

## 5. Known limitation (beta)

Resume granularity is per **stage**, not per **dimension**. A crash *inside* the
evidence stage (before its cursor advance) re-runs all five dimensions. Finer
per-dimension recovery + idempotency is the async-job Production TODO already
scoped in Architecture §3.

## 6. Done-When

`scripts/test-pipeline.js`:
- **Part A (hermetic):** `planResume` for every cursor value — from `intake` run
  all four; from `evidence_gathering` skip evidence and run the rest; from
  `scoring`/`verdict` run only the tail; from `complete` run nothing; unknown
  status throws.
- **Part B (real runner):** evidence is seeded and the cursor set to
  `evidence_gathering` to simulate a crash right after the evidence stage. The
  pipeline is run via `POST /ideas/:id/run` and must resume at scoring (evidence
  **skipped**, not re-gathered), run scoring→verdict→delivery, reach `complete`
  with 5 score rows + 1 verdict row (BURY @ 49.5) + persisted voice, and a
  second run must be an idempotent no-op that creates no duplicate rows.
