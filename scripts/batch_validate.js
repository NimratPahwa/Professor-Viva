// Professor Viva — batch validation runner.
//
// Reads a CSV of form submissions and runs each row through the EXISTING Layer-1
// pipeline, one idea at a time. This is a thin standalone wrapper — it does not
// change any core pipeline code; it only maps CSV columns onto the intake schema
// and calls the same createIdea + runPipeline the API uses.
//
// Column mapping (headers matched case-insensitively):
//   "idea in one sentence"  -> problem            (required)
//   "audience"              -> audience           (else "not provided")
//   "monetization hypothesis" -> monetization_hypothesis (else "not provided")
//   "unfair advantage"      -> unfair_advantage   (else "not provided")
//
// For each row it saves the verdict (BUILD/PIVOT/BURY + score + the 3 next steps)
// and the evidence-receipts link, plus the actual sourced links behind the
// verdict, to a JSON results file (written incrementally so a crash mid-batch
// keeps completed rows).
//
// Usage:  node scripts/batch_validate.js <input.csv> [output.json]

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const { validateIntake } = require('../lib/intake-schema');
const { createIdea, getIdeaById } = require('../lib/ideas-repo');
const { runPipeline } = require('../lib/pipeline');
const { getLatestVerdictForIdea } = require('../lib/verdicts-repo');
const { getEvidenceForIdea } = require('../lib/evidence-repo');
const { buildReceipts } = require('../lib/receipts');

const NOT_PROVIDED = 'not provided';

// ── Minimal RFC-4180-ish CSV parser (quotes, escaped "" quotes, commas and
// newlines inside quoted fields). No external dependency. ──
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (c === '\r') {
      // ignore; handled by the \n branch
    } else {
      field += c;
    }
  }
  // trailing field / row (file may not end in a newline)
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Finds the column index whose normalized header contains the needle.
function colIndex(headers, needle) {
  return headers.findIndex((h) => norm(h).includes(needle));
}

function rowToIntake(headers, cells) {
  const at = (needle) => {
    const idx = colIndex(headers, needle);
    if (idx < 0) return '';
    return String(cells[idx] || '').trim();
  };
  const problem = at('idea in one sentence') || at('idea');
  return {
    problem,
    audience: at('audience') || NOT_PROVIDED,
    monetization_hypothesis: at('monetization') || NOT_PROVIDED,
    unfair_advantage: at('unfair') || NOT_PROVIDED
  };
}

function httpLinksFrom(receipts) {
  return receipts.dimensions
    .flatMap((d) => d.claims)
    .map((c) => c.source_url)
    .filter((u) => /^https?:\/\//i.test(u));
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node scripts/batch_validate.js <input.csv> [output.json]');
    process.exit(2);
  }
  const outputPath = process.argv[3] || inputPath.replace(/\.csv$/i, '') + '.results.json';

  const raw = fs.readFileSync(path.resolve(inputPath), 'utf8');
  const grid = parseCSV(raw);
  if (grid.length < 2) {
    console.error('CSV has no data rows.');
    process.exit(2);
  }

  const headers = grid[0];
  const dataRows = grid.slice(1);
  console.log(`Loaded ${dataRows.length} row(s) from ${inputPath}. Running one at a time...\n`);

  const results = [];
  const save = () => fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

  for (let i = 0; i < dataRows.length; i++) {
    const rowNum = i + 1;
    const intake = rowToIntake(headers, dataRows[i]);
    console.log(`[row ${rowNum}] problem: "${intake.problem.slice(0, 80)}"`);

    const { valid, errors } = validateIntake(intake);
    if (!valid) {
      console.log(`[row ${rowNum}] SKIPPED — intake invalid: ${errors.map((e) => e.message).join('; ')}`);
      results.push({ row: rowNum, intake, error: 'invalid_intake', details: errors });
      save();
      continue;
    }

    try {
      const created = await createIdea(intake);
      // Run the FULL existing pipeline (evidence -> scoring -> verdict -> delivery).
      const run = await runPipeline(created.id);

      const idea = await getIdeaById(created.id);
      const verdictRow = await getLatestVerdictForIdea(created.id);
      const evidence = await getEvidenceForIdea(created.id);
      const receipts = buildReceipts({ idea, evidence, verdict: verdictRow });
      const sourceLinks = httpLinksFrom(receipts);

      const result = {
        row: rowNum,
        idea_id: created.id,
        status: run.idea.status,
        verdict: verdictRow.verdict,
        total_score: Number(verdictRow.total_score),
        next_steps: verdictRow.next_steps,
        receipts_url: `/ideas/${created.id}/receipts`,
        receipts_html_url: `/ideas/${created.id}/receipts.html`,
        card_url: verdictRow.card_asset_url,
        sourced_claim_count: receipts.total_claims,
        source_links: sourceLinks
      };
      results.push(result);
      save();

      console.log(`[row ${rowNum}] ${result.verdict} @ ${result.total_score}/100 · ${result.next_steps.length} next steps · ${sourceLinks.length} source links`);
      console.log(`[row ${rowNum}] receipts: ${result.receipts_url}`);
      result.next_steps.forEach((s, n) => console.log(`           step ${n + 1}: ${s}`));
      console.log('');
    } catch (err) {
      console.error(`[row ${rowNum}] FAILED: ${err.message}`);
      results.push({ row: rowNum, intake, error: 'pipeline_failed', message: err.message });
      save();
    }
  }

  const ok = results.filter((r) => r.verdict).length;
  console.log(`Done. ${ok}/${dataRows.length} verdict(s) produced. Results saved to ${outputPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
