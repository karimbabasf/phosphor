// What this app has spent on gas, grouped. One derivation, two doors: see gasReport.

import { sendJson } from '../respond.ts';
import { gasReport } from '../state.ts';
import type { ReadTable } from '../context.ts';

export const gasReads: ReadTable = {
  gas_report: (ctx, _body, args, res) => {
    const report = gasReport(ctx, String(args.window ?? '7d'));
    sendJson(res, report.status, report.body);
  },
};
