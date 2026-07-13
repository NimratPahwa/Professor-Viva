// Done-When demo for Step 1 (intake schema).
// Walks a sample payload through validateIntake() at 0, 1, 2, and 3
// clarifying questions (all valid) plus a 4th-question and a missing-field
// case (both invalid), and asserts no undefined behavior at any point.

const { validateIntake } = require('../lib/intake-schema');

const basePayload = {
  problem: 'Small contractors lose 10+ hours a week reconciling paper change orders against invoices.',
  audience: 'Independent general contractors running 2-10 active residential jobs at a time.',
  monetization_hypothesis: 'Usage-based SaaS, $49/mo per active job site, billed monthly.',
  unfair_advantage: 'Ten years running field ops for a mid-size GC; personal relationships with 40+ contractors who\'ve asked for this.'
};

const sampleQA = [
  { question: 'Who exactly wakes up angry about this problem?', answer: 'The GC themselves, not their office admin.' },
  { question: 'How do they solve this today?', answer: 'Spreadsheets and a shoebox of paper receipts.' },
  { question: 'What would make them switch tools?', answer: 'Anything that survives a lost phone.' }
];

let failures = 0;

function assert(condition, label) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`[${status}] ${label}`);
}

// 0 through 3 clarifying questions: all valid
for (let n = 0; n <= 3; n++) {
  const payload = { ...basePayload, clarifying_questions: sampleQA.slice(0, n) };
  const result = validateIntake(payload);
  assert(result.valid === true, `${n} clarifying question(s) -> valid (errors: ${JSON.stringify(result.errors)})`);
}

// 4 clarifying questions: must fail, cap enforced in code
const fourQuestions = [...sampleQA, { question: 'One question too many?', answer: 'Yes.' }];
const overCapResult = validateIntake({ ...basePayload, clarifying_questions: fourQuestions });
assert(overCapResult.valid === false, '4 clarifying questions -> invalid (cap enforced)');
assert(
  overCapResult.errors.some(e => e.field === 'clarifying_questions'),
  '4 clarifying questions -> error reports the correct field'
);

// Missing required field: must fail with a field-specific error, not a crash
const missingFieldResult = validateIntake({ ...basePayload, problem: undefined });
assert(missingFieldResult.valid === false, 'missing "problem" -> invalid');
assert(
  missingFieldResult.errors.some(e => e.field === 'problem'),
  'missing "problem" -> error names the "problem" field specifically'
);

// Non-object payload: must fail gracefully, not throw
let threw = false;
let nullResult;
try {
  nullResult = validateIntake(null);
} catch (e) {
  threw = true;
}
assert(threw === false, 'null payload -> does not throw');
assert(nullResult && nullResult.valid === false, 'null payload -> invalid');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
