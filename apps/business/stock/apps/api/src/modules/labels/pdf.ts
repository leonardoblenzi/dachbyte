import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

export type LabelEntity = {
  id: string;
  entityType: 'product' | 'location';
  primaryCode: string;
  title: string;
  subtitle?: string | null;
  qrToken: string;
  humanCode: string;
  barcode?: string | null;
};

export type LabelPdfOptions = {
  copies: number;
  templateName: string;
  includeBarcode: boolean;
  includePath: boolean;
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 36;
const GAP = 10;
const COLUMNS = 2;
const ROWS = 5;
const LABEL_WIDTH = (PAGE_WIDTH - MARGIN * 2 - GAP) / COLUMNS;
const LABEL_HEIGHT = (PAGE_HEIGHT - MARGIN * 2 - GAP * (ROWS - 1)) / ROWS;

function collectPdf(document: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });
}

function fitText(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}...`;
}

async function renderLabel(document: PDFKit.PDFDocument, entity: LabelEntity, x: number, y: number, options: LabelPdfOptions) {
  const qrBuffer = await QRCode.toBuffer(entity.qrToken, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 118,
    type: 'png'
  });

  document.roundedRect(x, y, LABEL_WIDTH, LABEL_HEIGHT, 8).lineWidth(0.7).strokeColor('#cbd5e1').stroke();
  document.rect(x, y, LABEL_WIDTH, 24).fill('#0f172a');
  document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text('VOLT STOCK', x + 12, y + 8, { width: LABEL_WIDTH - 24 });

  document.image(qrBuffer, x + 12, y + 38, { width: 92, height: 92 });

  const textX = x + 116;
  const textWidth = LABEL_WIDTH - 128;
  document.fillColor('#0f172a').font('Helvetica-Bold').fontSize(12).text(fitText(entity.title, 52), textX, y + 39, {
    width: textWidth,
    height: 32
  });

  document.fillColor('#334155').font('Helvetica').fontSize(8.5).text(entity.humanCode, textX, y + 76, { width: textWidth });
  document.fillColor('#475569').font('Helvetica').fontSize(8).text(fitText(entity.primaryCode, 42), textX, y + 91, { width: textWidth });

  if (options.includePath && entity.subtitle) {
    document.fillColor('#64748b').fontSize(7.5).text(fitText(entity.subtitle, 70), textX, y + 106, {
      width: textWidth,
      height: 22
    });
  }

  if (options.includeBarcode && entity.barcode) {
    document.fillColor('#0f172a').font('Helvetica-Bold').fontSize(7.5).text(`EAN ${entity.barcode}`, x + 12, y + LABEL_HEIGHT - 18, {
      width: LABEL_WIDTH - 24
    });
  }

  document.fillColor('#64748b').font('Helvetica').fontSize(6.5).text(options.templateName, x + 116, y + LABEL_HEIGHT - 18, {
    width: textWidth,
    align: 'right'
  });
}

export async function createLabelsPdf(entities: LabelEntity[], options: LabelPdfOptions): Promise<Buffer> {
  const expanded = entities.flatMap((entity) => Array.from({ length: options.copies }, () => entity));
  const document = new PDFDocument({
    size: 'A4',
    margin: 0,
    info: {
      Title: `Etiquetas Volt Stock - ${options.templateName}`,
      Subject: 'Etiquetas com QR Code interno',
      Creator: 'Volt Stock'
    }
  });
  const done = collectPdf(document);

  document.font('Helvetica');

  for (let index = 0; index < expanded.length; index += 1) {
    if (index > 0 && index % (COLUMNS * ROWS) === 0) {
      document.addPage();
    }

    const slot = index % (COLUMNS * ROWS);
    const column = slot % COLUMNS;
    const row = Math.floor(slot / COLUMNS);
    const entity = expanded[index];

    if (entity) {
      await renderLabel(document, entity, MARGIN + column * (LABEL_WIDTH + GAP), MARGIN + row * (LABEL_HEIGHT + GAP), options);
    }
  }

  document.end();
  return done;
}
