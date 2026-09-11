// Custom indicators: a JSON tree format the app evaluates, a Pine v5 translator onto it, and
// the loader that watches <dataDir>/indicators. See schema.ts for the format and the header
// of evaluate.ts for the budget.

export { customIndicatorSchema, LIMITS, OPS, SERIES, TONES, validateExprs } from './schema.ts';
export type { CustomIndicator, CustomInput, CustomPlot, Expr, Tone } from './schema.ts';
export { compile, WORK_BUDGET } from './evaluate.ts';
