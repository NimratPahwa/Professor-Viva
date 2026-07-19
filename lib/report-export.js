// Professor Viva — The Professor's Stage, Screen 5 exports (docs/15 §3/§4.5).
//
// Turns an assembled report into downloadable artifacts:
//   - PDF   — the full formatted six-answer report, with source URLs and a
//             professorviva.com footer on every page.
//   - Excel — the evidence table (dimension, claim, source_url, retrieved_at,
//             signal, channel).
// Both are generated from report DATA (real or mocked), so they are hermetically
// testable and never call the LLM. Each returns a Buffer.

const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

const FOOTER = 'professorviva.com · Department of Hard Truths';

// Renders the six-answer report to a PDF Buffer.
//   report — { idea, verdict, total_score, roast, next_steps[], six_answers[],
//             evidence[] } (the /report or /sample shape).
function reportToPdf(report) {
  return new Promise((resolve, reject) => {
    // bufferPages lets us stamp the footer on every page AFTER content is laid
    // out — writing a footer inline near the bottom margin would itself trigger
    // a new page (pageAdded → stamp → new page → …), an infinite recursion.
    const doc = new PDFDocument({ size: 'A4', margin: 54, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header.
    doc.fillColor('#201D13').fontSize(20).text('PROFESSOR VIVA', { continued: false });
    doc.fontSize(10).fillColor('#9a9587').text('Department of Hard Truths — The Six Answers');
    doc.moveDown(0.5);
    doc.fillColor('#201D13').fontSize(14).text(report.idea.problem);
    doc.fontSize(11).fillColor('#3D5C35')
      .text(`Verdict: ${report.verdict}    Score: ${report.total_score}/100`);
    doc.moveDown(0.5);

    if (report.roast) {
      doc.fontSize(10).fillColor('#201D13').text(report.roast, { align: 'left' });
      doc.moveDown(0.5);
    }

    // Next steps.
    if (Array.isArray(report.next_steps) && report.next_steps.length) {
      doc.fontSize(12).fillColor('#201D13').text('Your next steps');
      report.next_steps.forEach((s, i) => {
        doc.fontSize(10).fillColor('#201D13').text(`${i + 1}. ${s}`, { indent: 10 });
      });
      doc.moveDown(0.5);
    }

    // The six answers.
    for (const ans of report.six_answers || []) {
      doc.moveDown(0.3);
      doc.fontSize(12).fillColor('#201D13').text(`${ans.n}. ${ans.title}`);
      if (ans.body) {
        doc.fontSize(10).fillColor('#201D13').text(ans.body, { indent: 10 });
      }
      if (ans.subject) {
        doc.fontSize(10).fillColor('#9a9587').text(ans.subject, { indent: 10 });
      }
      for (const c of ans.claims || []) {
        doc.fontSize(9).fillColor('#201D13').text(`• ${c.claim}`, { indent: 16 });
        if (c.source_url) doc.fontSize(8).fillColor('#3D5C35').text(c.source_url, { indent: 22, link: c.source_url, underline: true });
      }
      if (ans.competitive && Array.isArray(ans.competitive.sections)) {
        for (const sec of ans.competitive.sections) {
          doc.fontSize(10).fillColor('#201D13').text(sec.title || sec.heading || 'Competitive', { indent: 10 });
          for (const item of sec.items || sec.claims || []) {
            const text = typeof item === 'string' ? item : (item.claim || item.text || '');
            if (text) doc.fontSize(9).fillColor('#201D13').text(`• ${text}`, { indent: 16 });
            if (item && item.source_url) doc.fontSize(8).fillColor('#3D5C35').text(item.source_url, { indent: 22, link: item.source_url, underline: true });
          }
        }
      }
    }

    // Stamp the professorviva.com footer on every buffered page.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.height - 40;
      doc.fontSize(8).fillColor('#9a9587')
        .text(FOOTER, 54, bottom, { width: doc.page.width - 108, align: 'center', lineBreak: false });
    }
    doc.flushPages();
    doc.end();
  });
}

// Renders the evidence table to an .xlsx Buffer.
async function reportToXlsx(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Professor Viva';
  const ws = wb.addWorksheet('Evidence');
  ws.columns = [
    { header: 'dimension', key: 'dimension', width: 16 },
    { header: 'claim', key: 'claim', width: 70 },
    { header: 'source_url', key: 'source_url', width: 45 },
    { header: 'retrieved_at', key: 'retrieved_at', width: 24 },
    { header: 'signal', key: 'signal', width: 12 },
    { header: 'channel', key: 'channel', width: 30 }
  ];
  ws.getRow(1).font = { bold: true };

  for (const e of report.evidence || []) {
    ws.addRow({
      dimension: e.dimension,
      claim: e.claim,
      source_url: e.source_url,
      retrieved_at: e.retrieved_at || '',
      signal: e.signal || 'neutral',
      channel: e.channel ? `${e.channel.name} (${e.channel.url})` : ''
    });
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { reportToPdf, reportToXlsx, FOOTER };
