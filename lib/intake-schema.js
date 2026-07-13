// Professor Viva — intake schema (Step 1 of the gap-closure plan)
// Machine-readable counterpart to docs/04-professor-viva-intake-schema.md
// Pure code, no LLM — matches 02-Architecture §2 principle 2.

const FIELD_RULES = {
  problem: { min: 10, max: 1000 },
  audience: { min: 5, max: 500 },
  monetization_hypothesis: { min: 10, max: 1000 },
  unfair_advantage: { min: 5, max: 1000 }
};

const MAX_CLARIFYING_QUESTIONS = 3;
const QUESTION_RULES = { min: 5, max: 300 };
const ANSWER_RULES = { min: 1, max: 1000 };

function checkStringField(value, rules, fieldName, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({ field: fieldName, message: `${fieldName} is required.` });
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length < rules.min || trimmed.length > rules.max) {
    errors.push({
      field: fieldName,
      message: `${fieldName} must be between ${rules.min} and ${rules.max} characters (got ${trimmed.length}).`
    });
  }
}

function validateIntake(payload) {
  const errors = [];

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: [{ field: 'payload', message: 'Payload must be an object.' }] };
  }

  for (const [fieldName, rules] of Object.entries(FIELD_RULES)) {
    checkStringField(payload[fieldName], rules, fieldName, errors);
  }

  const clarifyingQuestions = payload.clarifying_questions === undefined
    ? []
    : payload.clarifying_questions;

  if (!Array.isArray(clarifyingQuestions)) {
    errors.push({ field: 'clarifying_questions', message: 'clarifying_questions must be an array.' });
  } else {
    if (clarifyingQuestions.length > MAX_CLARIFYING_QUESTIONS) {
      errors.push({
        field: 'clarifying_questions',
        message: `clarifying_questions may not exceed ${MAX_CLARIFYING_QUESTIONS} items (got ${clarifyingQuestions.length}).`
      });
    }
    clarifyingQuestions.forEach((item, i) => {
      if (item === null || typeof item !== 'object') {
        errors.push({ field: `clarifying_questions[${i}]`, message: 'Each item must be an object with question and answer.' });
        return;
      }
      checkStringField(item.question, QUESTION_RULES, `clarifying_questions[${i}].question`, errors);
      checkStringField(item.answer, ANSWER_RULES, `clarifying_questions[${i}].answer`, errors);
    });
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateIntake, FIELD_RULES, MAX_CLARIFYING_QUESTIONS };
