import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, PageSizes } from 'pdf-lib';
import { sanitizePdfText as sanitize } from './pdfText';
import type { Project, GrossMarginForm } from '../types';
// White variant — the header band is navy, so the navy-text color logo would
// disappear into it.
import instrataLogoUrl from '../assets/instrata-logo-white.png';

// Brand palette (mirrors exportWarrantyPDF.ts / exportCloseoutPDF.ts)
const NAVY = rgb(0.133, 0.196, 0.431);
const ORANGE = rgb(0.965, 0.553, 0.180);
const WHITE = rgb(1, 1, 1);
const LIGHT_GRAY = rgb(0.94, 0.945, 0.96);
const DARK_GRAY = rgb(0.3, 0.3, 0.35);
const MID_GRAY = rgb(0.5, 0.5, 0.55);
const BLACK = rgb(0.1, 0.1, 0.1);

const PAGE_W = PageSizes.Letter[0];
const PAGE_H = PageSizes.Letter[1];
const MARGIN = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;
// Numeric columns (right edges) for the Cost / Price table.
const COL_COST_R = PAGE_W - MARGIN - 120;
const COL_PRICE_R = PAGE_W - MARGIN;
const COL_HOURS_R = PAGE_W - MARGIN - 250;

const usd = (n: number) =>
  '$' + (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hrs = (n: number | undefined) => (n != null ? `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} hrs` : '');

async function fetchImageBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  return new Uint8Array(await res.arrayBuffer());
}

/** Right-align text at an x edge. */
function drawRight(page: PDFPage, text: string, xRight: number, y: number, font: PDFFont, size: number, color = BLACK) {
  const t = sanitize(text);
  page.drawText(t, { x: xRight - font.widthOfTextAtSize(t, size), y, size, font, color });
}

export async function exportGrossMarginPDF(project: Project, form: GrossMarginForm): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

  let logo;
  try { logo = await pdf.embedPng(await fetchImageBytes(instrataLogoUrl)); } catch { /* logo optional */ }

  const page = pdf.addPage(PageSizes.Letter);
  let y = PAGE_H;

  // ── Top brand band ────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: PAGE_H - 64, width: PAGE_W, height: 64, color: NAVY });
  page.drawRectangle({ x: 0, y: PAGE_H - 68, width: PAGE_W, height: 4, color: ORANGE });
  if (logo) {
    const w = 150; const s = w / logo.width;
    page.drawImage(logo, { x: MARGIN, y: PAGE_H - 46, width: w, height: logo.height * s });
  }
  drawRight(page, 'Gross Margin Form', PAGE_W - MARGIN, PAGE_H - 30, bold, 18, WHITE);
  drawRight(page, sanitize(project.number || ''), PAGE_W - MARGIN, PAGE_H - 50, font, 10, rgb(0.8, 0.84, 0.95));
  y = PAGE_H - 92;

  // ── Section header helper ───────────────────────────────────────────────────
  const section = (label: string) => {
    page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: 18, color: LIGHT_GRAY });
    page.drawText(label, { x: MARGIN + 6, y, size: 9, font: bold, color: NAVY });
    y -= 26;
  };
  // ── label : value row (two per line) ────────────────────────────────────────
  const kv = (pairs: { label: string; value: string }[]) => {
    const colW = CONTENT_W / 2;
    for (let i = 0; i < pairs.length; i += 2) {
      for (let c = 0; c < 2; c++) {
        const p = pairs[i + c];
        if (!p) continue;
        const x = MARGIN + c * colW;
        page.drawText(p.label, { x, y, size: 8, font: bold, color: NAVY });
        const labelW = bold.widthOfTextAtSize(p.label, 8);
        let v = sanitize(p.value || '—');
        const maxW = colW - labelW - 14;
        while (font.widthOfTextAtSize(v, 8) > maxW && v.length > 1) v = v.slice(0, -1);
        page.drawText(v, { x: x + labelW + 8, y, size: 8, font, color: DARK_GRAY });
      }
      y -= 16;
    }
    y -= 6;
  };
  // ── amount row: label | hours | cost | price ────────────────────────────────
  const amountHeader = () => {
    drawRight(page, 'Cost', COL_COST_R, y, bold, 8, NAVY);
    drawRight(page, 'Price', COL_PRICE_R, y, bold, 8, NAVY);
    y -= 14;
  };
  const row = (label: string, opts: { hours?: number; cost?: number; price?: number; strong?: boolean; rule?: boolean }) => {
    if (opts.rule) {
      page.drawLine({ start: { x: MARGIN, y: y + 11 }, end: { x: PAGE_W - MARGIN, y: y + 11 }, thickness: 0.5, color: LIGHT_GRAY });
    }
    const f = opts.strong ? bold : font;
    page.drawText(label, { x: MARGIN, y, size: 9, font: f, color: opts.strong ? NAVY : BLACK });
    if (opts.hours != null) drawRight(page, hrs(opts.hours), COL_HOURS_R, y, font, 9, MID_GRAY);
    if (opts.cost != null) drawRight(page, usd(opts.cost), COL_COST_R, y, f, 9, opts.strong ? NAVY : BLACK);
    if (opts.price != null) drawRight(page, usd(opts.price), COL_PRICE_R, y, f, 9, opts.strong ? NAVY : BLACK);
    y -= 18;
  };

  // ── Job Specific Information ─────────────────────────────────────────────────
  const h = form.header;
  section('Job Specific Information');
  kv([
    { label: 'Project Name', value: h.projectName || project.name },
    { label: 'Quote Number', value: h.quoteNumber },
    { label: 'Client Name', value: h.clientName || project.client },
    { label: 'PO Number', value: h.poNumber },
    { label: 'Site Address', value: h.siteAddress },
    { label: 'Sales Rep', value: h.salesRep },
    { label: 'Billing Address', value: h.billingAddress },
    { label: 'Engineer', value: h.engineer },
    { label: 'Client Email', value: h.clientEmail },
  ]);

  // ── Quote Specific Information ───────────────────────────────────────────────
  section('Quote Specific Information');
  amountHeader();
  row('Install Hours', { hours: form.installHours.hours, cost: form.installHours.cost, price: form.installHours.price });
  row('Programming Hours', { hours: form.programmingHours.hours, cost: form.programmingHours.cost, price: form.programmingHours.price });
  row('Travel', { hours: form.travel.hours, cost: form.travel.cost, price: form.travel.price });
  row('Labor Totals', { hours: form.laborTotals.hours, cost: form.laborTotals.cost, price: form.laborTotals.price, strong: true, rule: true });
  y -= 4;
  row('Equipment', { cost: form.equipment.cost, price: form.equipment.price });
  row('Subcontractor', { cost: form.subcontractor.cost, price: form.subcontractor.price });
  row('Equipment Rental', { cost: form.equipmentRental.cost, price: form.equipmentRental.price });
  row('Permits', { cost: form.permits.cost, price: form.permits.price });
  row('Equipment Totals', { cost: form.equipmentTotals.cost, price: form.equipmentTotals.price, strong: true, rule: true });
  y -= 6;
  row('PROJECT TOTALS', { cost: form.projectTotals.cost, price: form.projectTotals.price, strong: true, rule: true });
  y -= 8;

  // ── Tax Information ───────────────────────────────────────────────────────────
  section('Tax Information');
  page.drawText('Tax Rate', { x: MARGIN, y, size: 8, font: bold, color: NAVY });
  page.drawText(`${(form.tax.rate * 100).toFixed(2)}%`, { x: MARGIN + 50, y, size: 8, font, color: DARK_GRAY });
  y -= 16;
  page.drawText('Materials Tax', { x: MARGIN, y, size: 8, font: bold, color: NAVY });
  page.drawText(usd(form.tax.materialsTax), { x: MARGIN + 70, y, size: 8, font, color: DARK_GRAY });
  page.drawText('Labor Tax', { x: MARGIN + 230, y, size: 8, font: bold, color: NAVY });
  page.drawText(usd(form.tax.laborTax), { x: MARGIN + 290, y, size: 8, font, color: DARK_GRAY });
  y -= 24;

  // ── Custom Job Information + Premiere Protect ───────────────────────────────
  section('Custom Job Information');
  const cu = form.custom;
  const customPairs = [
    { label: 'Subsidiary', value: cu.subsidiary },
    { label: 'Branch', value: cu.branch },
    { label: 'Project Type', value: cu.projectType },
    { label: 'AIA Invoicing Required', value: cu.aiaInvoicing },
    { label: 'Prevailing Wage', value: cu.prevailingWage },
    { label: 'T&M?', value: cu.timeAndMaterials },
    { label: 'Material Only?', value: cu.materialOnly },
  ];
  for (const p of customPairs) {
    page.drawText(p.label, { x: MARGIN, y, size: 8, font: bold, color: NAVY });
    page.drawText(sanitize(p.value || '—'), { x: MARGIN + 140, y, size: 8, font, color: DARK_GRAY });
    y -= 16;
  }
  // Premiere Protect — its own full-width row so the dollar values have room
  // (a right-half inline label crowded the cost column).
  y -= 4;
  page.drawLine({ start: { x: MARGIN, y: y + 11 }, end: { x: PAGE_W - MARGIN, y: y + 11 }, thickness: 0.5, color: LIGHT_GRAY });
  drawRight(page, 'Cost', COL_COST_R, y, bold, 8, NAVY);
  drawRight(page, 'Price', COL_PRICE_R, y, bold, 8, NAVY);
  y -= 16;
  page.drawText('Premiere Protect', { x: MARGIN, y, size: 9, font: bold, color: NAVY });
  drawRight(page, usd(form.premiereProtect.cost), COL_COST_R, y, font, 9, BLACK);
  drawRight(page, usd(form.premiereProtect.price), COL_PRICE_R, y, font, 9, BLACK);
  y -= 18;

  // ── Footer ───────────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 6, color: ORANGE });
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const footer = `Instrata Project Tools — Gross Margin Form · Generated ${today}`;
  page.drawText(footer, { x: MARGIN, y: 16, size: 8, font: italic, color: MID_GRAY });
  if (!form.verified) {
    drawRight(page, 'Figures edited / not reconciled to DTools', PAGE_W - MARGIN, 16, italic, 8, ORANGE);
  }

  // ── Save & download ────────────────────────────────────────────────────────
  const bytes = await pdf.save();
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.number || 'Project'} - Gross Margin Form.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
