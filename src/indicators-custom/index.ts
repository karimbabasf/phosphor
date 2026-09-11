// Custom indicators: a JSON tree format the app evaluates, a Pine v5 translator onto it, and
// the loader that watches <dataDir>/indicators. See schema.ts for the format and the header
// of evaluate.ts for the budget.

export { customIndicatorSchema, LIMITS, OPS, SERIES, TONES, validateExprs } from './schema.ts';
export type { CustomIndicator, CustomInput, CustomPlot, Expr, Tone } from './schema.ts';
export { compile, WORK_BUDGET } from './evaluate.ts';
export { translatePine } from './pine.ts';
export type { PineResult } from './pine.ts';
export { createCustomIndicators, FILE_CAP_BYTES, SLUG_RE } from './loader.ts';
export type { CustomIndicators, LoaderProblem } from './loader.ts';
