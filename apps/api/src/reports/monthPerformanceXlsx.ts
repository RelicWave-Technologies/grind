import ExcelJS from 'exceljs';
import {
  fmtMinutes,
  monthPerformanceGridRows,
  monthPerformanceSummaryPairs,
  type MonthPerformanceCode,
  type MonthPerformanceDay,
  type MonthPerformanceReport,
  type MonthPerformanceRow,
} from './monthPerformance';

/**
 * The month performance report as a real .xlsx workbook, styled to DESIGN.md.
 *
 * The grid itself is `monthPerformanceGridRows`, the same six rows the CSV
 * writes, so neither export can grow a column the other lacks. What this adds
 * is the part a CSV cannot carry.
 *
 * ## The design system, applied to a spreadsheet
 *
 * DESIGN.md is a monochrome editorial frame interrupted by oversized pastel
 * colour blocks, and a month grid turns out to be an unusually good fit for it:
 * the chrome — every label, every clock reading, every heading — is pure black
 * ink on pure white canvas, and the one place colour appears is the Status row,
 * where each day becomes its own small block of lime, cream, pink or lilac.
 * Read at a distance the sheet is a band of colour per person; read up close it
 * is black text on white paper.
 *
 * Three rules from DESIGN.md do most of the work here:
 *
 *   - **No mid-grey text.** Hierarchy comes from weight and size, never from a
 *     softer grey. Weekday labels and captions are black, just smaller and
 *     lighter, which is why this file has no `999999` anywhere.
 *   - **No colour outside the block palette.** The status fills are the
 *     documented `block-*` tokens and nothing else — no red for absence, no
 *     green for present. Colour marks a category, it does not grade it.
 *   - **No shadows; hairlines instead.** Blocks are separated by a 1px
 *     `hairline` rule, the same device DESIGN.md uses for pricing cards.
 *
 * Mono is taxonomy: day numbers, weekdays, clock readings and the count strip
 * are all set in the mono face, uppercase where they are labels. The sans face
 * is reserved for a person's name and the sheet title.
 *
 * Three sheets, because three different questions get asked of this report:
 * "Month Performance" is the per-person grid HR already knows how to read,
 * "Summary" is one row per person for the question the grid answers slowly
 * (who was in, and how much), and "Legend" spells out codes that are only
 * obvious to somebody who already knows them.
 */

// ---------------------------------------------------------------------------
// DESIGN.md tokens
// ---------------------------------------------------------------------------

/** `{colors.*}`, as the ARGB strings ExcelJS wants. */
const INK = 'FF000000';
const CANVAS = 'FFFFFFFF';
const HAIRLINE = 'FFE6E6E6';
const HAIRLINE_SOFT = 'FFF1F1F1';
const SURFACE_SOFT = 'FFF7F7F5';
const BLOCK_LIME = 'FFDCEEB1';
const BLOCK_LILAC = 'FFC5B0F4';
const BLOCK_CREAM = 'FFF4ECD6';
const BLOCK_PINK = 'FFEFD4D4';
const BLOCK_MINT = 'FFC8E6CD';
const BLOCK_CORAL = 'FFF3C9B6';

/**
 * `figmaSans` / `figmaMono` are proprietary, so DESIGN.md's documented
 * open-source substitutes are used. A spreadsheet cannot carry a fallback
 * stack the way CSS can — Excel silently substitutes a missing face — so the
 * second name is what most machines will actually render.
 */
const SANS = 'Inter';
const MONO = 'JetBrains Mono';

/**
 * Status fills, drawn only from `{colors.block-*}` plus the two neutral
 * surfaces. Ink stays black on every one of them: DESIGN.md carries meaning in
 * the surface, not in coloured type.
 *
 * The assignment is by category, not by judgement — `A` is not a red warning,
 * it is simply a different block from `P`. Days off share the quiet neutrals so
 * the eye reads them as background rather than as events.
 */
const CODE_FILL: Record<MonthPerformanceCode, string> = {
  P: BLOCK_LIME,
  HD: BLOCK_CREAM,
  A: BLOCK_PINK,
  PL: BLOCK_MINT,
  LWP: BLOCK_CORAL,
  HL: BLOCK_LILAC,
  WO: SURFACE_SOFT,
  '--': HAIRLINE_SOFT,
};

/** Wide enough for "Total Working Hours" without truncating it. */
const LABEL_COL_WIDTH = 21;
const DAY_COL_WIDTH = 5.6;

/** A masthead, then one block per person. */
const HEADER_ROWS = 3;
/** Two caption rows, then the six from `monthPerformanceGridRows`. */
const CAPTION_ROWS = 2;
const GRID_ROWS = 6;
const BLOCK_ROWS = CAPTION_ROWS + GRID_ROWS;
/** Whitespace is DESIGN.md's section break. One blank row ran the blocks
 *  together; three lets each person read as their own panel. */
const BLANK_ROWS_BETWEEN_BLOCKS = 3;

/** Offsets within a block, from its first row. */
const IDENTITY_ROW = 0;
const META_ROW = 1;
const DAY_NUMBER_ROW = 2;
const WEEKDAY_ROW = 3;
const FIRST_DATA_ROW = 4;
const STATUS_ROW = 7;

/**
 * How far the identity caption runs before the count strip takes over.
 *
 * The strip carries the counts spelled out in full — "Leave Without Pay 0",
 * not "LWP 0" — which needs most of the sheet's width to sit on one line, so
 * the name and email give up a couple of columns they were not using.
 */
const CAPTION_SPLIT_COL = 10;

type Font = Partial<ExcelJS.Font>;

/** `{typography.*}`, as far as a spreadsheet can express them. */
const TYPE = {
  displayLg: { name: SANS, size: 18, bold: true, color: { argb: INK } } as Font,
  cardTitle: { name: SANS, size: 11, bold: true, color: { argb: INK } } as Font,
  body: { name: SANS, size: 10, color: { argb: INK } } as Font,
  /** figmaMono uppercase — eyebrows, captions, taxonomy. */
  eyebrow: { name: MONO, size: 8, bold: true, color: { argb: INK } } as Font,
  caption: { name: MONO, size: 7.5, color: { argb: INK } } as Font,
  /**
   * The per-person count strip. Two roles, not one: the label names a category
   * and the number is the answer, so the number is set larger and heavier and
   * the label stays quiet beside it. Same ink for both — DESIGN.md carries
   * hierarchy in weight, never in a softer grey.
   */
  countLabel: { name: MONO, size: 8, color: { argb: INK } } as Font,
  countValue: { name: MONO, size: 11, bold: true, color: { argb: INK } } as Font,
  /** The grid's own readings: clock times, durations, codes. */
  reading: { name: MONO, size: 8, color: { argb: INK } } as Font,
  readingStrong: { name: MONO, size: 8, bold: true, color: { argb: INK } } as Font,
};

const CENTRE: Partial<ExcelJS.Alignment> = { horizontal: 'center', vertical: 'middle' };

function mergeAcross(sheet: ExcelJS.Worksheet, row: number, from: number, to: number): void {
  if (to > from) sheet.mergeCells(row, from, row, to);
}

/** A 1px `{colors.hairline}` rule along the top of a row — DESIGN.md's only
 *  separator device, standing in for the shadows it does not use. */
function ruleAbove(sheet: ExcelJS.Worksheet, row: number, lastCol: number, colour = HAIRLINE): void {
  for (let c = 1; c <= lastCol; c++) {
    sheet.getRow(row).getCell(c).border = { top: { style: 'thin', color: { argb: colour } } };
  }
}

function fill(cell: ExcelJS.Cell, argb: string): void {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/**
 * Counts that print even when they are zero.
 *
 * Present, Absent and Total Hours are the spine of a month — a zero in any of
 * them is itself the finding, so they always appear. The rest are events: a
 * half day, a holiday, leave. Printing "PAID LEAVE 0 · LEAVE WITHOUT PAY 0" on
 * a month where neither happened is three words of noise per person, and on a
 * 109-person sheet it is what turns the strip into a wall.
 */
const ALWAYS_SHOWN = new Set(['Present', 'Absent', 'Total Hours']);

/**
 * The count strip as rich text: a quiet label, then the number it answers, set
 * larger and bolder so the eye lands on the figure rather than reading the line.
 *
 * Separated by space rather than by a bullet. With the numbers now carrying the
 * weight, a row of dots is scaffolding the type no longer needs — and DESIGN.md
 * reaches for whitespace before it reaches for a separator.
 */
function countsRichText(row: MonthPerformanceRow): ExcelJS.CellRichTextValue {
  const richText: ExcelJS.RichText[] = [];
  const shown = monthPerformanceSummaryPairs(row)
    .filter(([label, value]) => ALWAYS_SHOWN.has(label) || value !== '0');

  for (const [i, [label, value]] of shown.entries()) {
    if (i > 0) richText.push({ font: TYPE.countLabel, text: '      ' });
    // Thin space between label and figure: they are one unit, not two.
    richText.push({ font: TYPE.countLabel, text: `${label.toUpperCase()}\u2009 ` });
    richText.push({ font: TYPE.countValue, text: value });
  }
  return { richText };
}

function buildGridSheet(wb: ExcelJS.Workbook, report: MonthPerformanceReport): void {
  const sheet = wb.addWorksheet('Month Performance', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: HEADER_ROWS }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    properties: { defaultRowHeight: 14 },
  });

  const dayCount = report.dates.length;
  const lastCol = dayCount + 1;
  sheet.getColumn(1).width = LABEL_COL_WIDTH;
  for (let i = 0; i < dayCount; i++) sheet.getColumn(i + 2).width = DAY_COL_WIDTH;

  // Masthead — display type over a mono eyebrow, on white canvas.
  sheet.addRow(['Month Performance']);
  sheet.addRow([
    [report.companyName, report.monthLabel, report.tz].filter(Boolean).join('   ·   ').toUpperCase(),
  ]);
  sheet.addRow([]);
  mergeAcross(sheet, 1, 1, Math.min(14, lastCol));
  mergeAcross(sheet, 2, 1, Math.min(14, lastCol));
  sheet.getRow(1).getCell(1).font = TYPE.displayLg;
  sheet.getRow(1).height = 26;
  sheet.getRow(2).getCell(1).font = TYPE.eyebrow;

  report.rows.forEach((row, index) => {
    const blockStart = HEADER_ROWS + index * (BLOCK_ROWS + BLANK_ROWS_BETWEEN_BLOCKS) + 1;
    sheet.addRow([row.user.name]);
    sheet.addRow([
      [row.user.teamName, row.user.email].filter(Boolean).join('   ·   ').toUpperCase(),
    ]);
    for (const cells of monthPerformanceGridRows(report, row)) sheet.addRow(cells);
    for (let i = 0; i < BLANK_ROWS_BETWEEN_BLOCKS; i++) sheet.addRow([]);

    const at = (offset: number) => sheet.getRow(blockStart + offset);
    const splitAt = Math.min(CAPTION_SPLIT_COL, lastCol);

    // A hairline opens each person's block. DESIGN.md separates with rules and
    // whitespace, never with a shadow or a heavier band of colour.
    ruleAbove(sheet, blockStart + IDENTITY_ROW, lastCol);

    mergeAcross(sheet, blockStart + IDENTITY_ROW, 1, splitAt);
    at(IDENTITY_ROW).getCell(1).font = TYPE.cardTitle;
    at(IDENTITY_ROW).height = 21;

    mergeAcross(sheet, blockStart + META_ROW, 1, splitAt);
    at(META_ROW).getCell(1).font = TYPE.caption;

    // The month's counts sit opposite the name, in mono, as a taxonomy strip.
    if (lastCol > splitAt) {
      const cell = at(IDENTITY_ROW).getCell(splitAt + 1);
      cell.value = countsRichText(row);
      mergeAcross(sheet, blockStart + IDENTITY_ROW, splitAt + 1, lastCol);
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
    }

    for (const offset of [DAY_NUMBER_ROW, WEEKDAY_ROW]) {
      const header = at(offset);
      for (let c = 1; c <= lastCol; c++) {
        header.getCell(c).font = offset === DAY_NUMBER_ROW ? TYPE.eyebrow : TYPE.caption;
        header.getCell(c).alignment = CENTRE;
      }
    }
    ruleAbove(sheet, blockStart + FIRST_DATA_ROW, lastCol, HAIRLINE_SOFT);

    // IN / OUT / WORK / Status — mono readings, black ink, centred. Only the
    // status row carries a surface colour.
    const byDate = new Map<string, MonthPerformanceDay>(row.days.map((d) => [d.date, d]));
    for (let offset = FIRST_DATA_ROW; offset <= STATUS_ROW; offset++) {
      const sheetRow = at(offset);
      const label = sheetRow.getCell(1);
      label.value = String(label.value ?? '').toUpperCase();
      label.font = TYPE.eyebrow;
      label.alignment = { horizontal: 'left', vertical: 'middle' };
      sheetRow.height = offset === STATUS_ROW ? 17 : 14;
      for (let i = 0; i < dayCount; i++) {
        const cell = sheetRow.getCell(i + 2);
        cell.alignment = CENTRE;
        cell.font = TYPE.reading;
        if (offset === STATUS_ROW) {
          const code = byDate.get(report.dates[i]!)?.code ?? '--';
          fill(cell, CODE_FILL[code]);
          cell.font = TYPE.readingStrong;
        }
      }
    }
  });
}

function buildSummarySheet(wb: ExcelJS.Workbook, report: MonthPerformanceReport): void {
  const sheet = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    { header: 'Name', key: 'name', width: 26 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Dept.', key: 'team', width: 24 },
    { header: 'Present', key: 'present', width: 9 },
    { header: 'Half day', key: 'halfDay', width: 10 },
    { header: 'Weekly off', key: 'weeklyOff', width: 11 },
    { header: 'Holiday', key: 'holiday', width: 9 },
    { header: 'Paid leave', key: 'paidLeave', width: 11 },
    { header: 'Unpaid leave', key: 'unpaidLeave', width: 13 },
    { header: 'Absent', key: 'absent', width: 9 },
    { header: 'No shift', key: 'noShift', width: 9 },
    { header: 'Total working hours', key: 'work', width: 18 },
  ];

  // Column heads are mono uppercase — DESIGN.md's caption role.
  const head = sheet.getRow(1);
  head.height = 20;
  head.eachCell((cell) => {
    cell.value = String(cell.value ?? '').toUpperCase();
    cell.font = TYPE.eyebrow;
    cell.alignment = { vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: HAIRLINE } } };
  });

  for (const row of report.rows) {
    const added = sheet.addRow({
      name: row.user.name,
      email: row.user.email,
      team: row.user.teamName ?? '',
      present: row.totals.present,
      halfDay: row.totals.halfDay,
      weeklyOff: row.totals.weeklyOff,
      holiday: row.totals.holiday,
      paidLeave: row.totals.paidLeave,
      unpaidLeave: row.totals.unpaidLeave,
      absent: row.totals.absent,
      noShift: row.totals.noShift,
      work: fmtMinutes(row.totals.workMinutes),
    });
    added.eachCell((cell, col) => {
      cell.font = col <= 3 ? TYPE.body : TYPE.reading;
      if (col > 3) cell.alignment = { horizontal: 'center' };
      cell.border = { bottom: { style: 'thin', color: { argb: HAIRLINE_SOFT } } };
    });
  }
}

/** The codes are only obvious to somebody who already knows them. */
function buildLegendSheet(wb: ExcelJS.Workbook): void {
  const sheet = wb.addWorksheet('Legend');
  sheet.getColumn(1).width = 8;
  sheet.getColumn(2).width = 62;

  sheet.addRow(['Legend']);
  sheet.getRow(1).getCell(1).font = TYPE.displayLg;
  sheet.getRow(1).height = 26;
  sheet.addRow([]);

  const legend: Array<[MonthPerformanceCode, string]> = [
    ['P', 'Present — any tracked time on the day'],
    ['HD', 'Half day — approved leave covering half the day'],
    ['A', 'Absent — a working day with no tracked time at all'],
    ['WO', 'Weekly off — the assigned shift has this weekday off'],
    ['HL', 'Company holiday'],
    ['PL', 'Approved paid leave'],
    ['LWP', 'Approved unpaid leave'],
    ['--', 'No shift assignment covers this date, and nothing tracked'],
  ];
  for (const [code, means] of legend) {
    const row = sheet.addRow({});
    const swatch = row.getCell(1);
    swatch.value = code;
    fill(swatch, CODE_FILL[code]);
    swatch.font = TYPE.readingStrong;
    swatch.alignment = CENTRE;
    row.getCell(2).value = means;
    row.getCell(2).font = TYPE.body;
    row.height = 17;
  }

  sheet.addRow([]);
  const notes = [
    'Office In / Office Out are the biometric punch record, shown as recorded.',
    '--:-- means no punch, which is not the same as 00:00.',
    'Total Working Hours is what Timo tracked — work, meetings and approved',
    'manual time. It is NOT the gap between the two punches.',
    'Leave and holidays come from the Lark calendar and win outright — a day',
    'stays PL or HL even when the person worked, and the hours still show.',
    'Otherwise: any tracked time reads P, none reads A. There is no minimum.',
  ];
  const firstNote = sheet.rowCount + 1;
  for (const note of notes) {
    const row = sheet.addRow(['', note]);
    row.getCell(2).font = TYPE.caption;
  }
  ruleAbove(sheet, firstNote, 2);
}

/** Render the workbook. Returns the bytes an HTTP response can send. */
export async function monthPerformanceXlsx(report: MonthPerformanceReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Timo';
  wb.created = new Date(report.generatedAtMs);

  buildGridSheet(wb, report);
  buildSummarySheet(wb, report);
  buildLegendSheet(wb);

  // White canvas everywhere. Excel's default is an unpainted sheet that picks
  // up the viewer's own theme; DESIGN.md's ground is explicitly `{colors.canvas}`.
  for (const sheet of wb.worksheets) {
    sheet.views = sheet.views.map((v) => ({ ...v, showGridLines: false }));
    for (let r = 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      for (let c = 1; c <= Math.max(sheet.columnCount, 1); c++) {
        const cell = row.getCell(c);
        if (!cell.fill) fill(cell, CANVAS);
      }
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export { fmtMinutes };
export type { MonthPerformanceRow };
