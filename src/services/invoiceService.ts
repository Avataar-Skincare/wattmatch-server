import PDFDocument from 'pdfkit';
import { Invoice } from '../models/Invoice.js';
import { Payment, type PaymentPurpose } from '../models/Payment.js';
import { Organization } from '../models/Organization.js';
import { uploadObject } from '../lib/s3.js';
import { logger } from '../lib/logger.js';

const PURPOSE_LABELS: Record<PaymentPurpose, string> = {
  rfs_document: 'RfS Document (Bid Purchase) Fee',
  bid_processing: 'Bid Processing Fee',
  emd: 'Earnest Money Deposit',
  success_charge: 'Success Charge',
};

// Wattmatch does not yet hold a GSTIN (see PricingPage.tsx's own note) — issuing a document that
// claims to be a "Tax Invoice" with a fabricated or blank GSTIN would be actively misleading, not
// just incomplete. Until WATTMATCH_GSTIN is configured this generates a clearly-labeled
// provisional receipt with no tax charged instead; the moment that env var is set (post GST
// registration), every subsequently generated document automatically becomes a real tax invoice —
// nothing here needs code changes, just configuration.
function sellerDetails() {
  return {
    name: process.env.WATTMATCH_LEGAL_NAME || '[Wattmatch legal entity name — pending incorporation/registration]',
    gstin: process.env.WATTMATCH_GSTIN || null,
    address: process.env.WATTMATCH_REGISTERED_ADDRESS || '[Registered address pending]',
  };
}

function financialYearLabel(d: Date): string {
  // Indian FY runs April-March.
  const year = d.getUTCFullYear();
  const startYear = d.getUTCMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

async function resolveBuyer(payment: Payment): Promise<{ name: string; email: string }> {
  if (payment.payerName && payment.payerEmail) return { name: payment.payerName, email: payment.payerEmail };
  if (payment.organizationId) {
    const org = await Organization.findByPk(payment.organizationId);
    if (org) return { name: org.name, email: org.contactEmail };
  }
  return { name: payment.payerName ?? 'Unknown', email: payment.payerEmail ?? 'unknown' };
}

interface InvoicePdfData {
  invoiceNumber: string;
  purposeLabel: string;
  seller: ReturnType<typeof sellerDetails>;
  buyer: { name: string; email: string };
  baseAmountPaise: number;
  gstRatePercent: number;
  taxPaise: number;
  totalPaise: number;
  currency: string;
}

function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const isTaxInvoice = Boolean(data.seller.gstin);
    const money = (paise: number) => `${data.currency} ${(paise / 100).toFixed(2)}`;

    doc.fontSize(18).text(isTaxInvoice ? 'Tax Invoice' : 'Provisional Receipt', { align: 'center' });
    if (!isTaxInvoice) {
      doc
        .fontSize(9)
        .fillColor('#B53A3A')
        .text('GSTIN registration pending — no tax charged. This is not a GST tax invoice.', { align: 'center' })
        .fillColor('black');
    }
    doc.moveDown();
    doc.fontSize(10);
    doc.text(`Invoice Number: ${data.invoiceNumber}`);
    doc.text(`Issue Date: ${new Date().toISOString().slice(0, 10)}`);
    doc.moveDown();
    doc.text(`Seller: ${data.seller.name}`);
    if (data.seller.gstin) doc.text(`GSTIN: ${data.seller.gstin}`);
    doc.text(`Address: ${data.seller.address}`);
    doc.moveDown();
    doc.text(`Billed to: ${data.buyer.name} (${data.buyer.email})`);
    doc.moveDown();
    doc.text(`Description: ${data.purposeLabel}`);
    doc.text(`Amount: ${money(data.baseAmountPaise)}`);
    if (isTaxInvoice) {
      doc.text(`GST (${data.gstRatePercent}%): ${money(data.taxPaise)}`);
    }
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Total: ${money(data.totalPaise)}`, { underline: true });
    doc.moveDown(2);
    doc.fontSize(8).fillColor('gray').text('This is a system-generated document.', { align: 'center' });
    doc.end();
  });
}

// Called from paymentStateMachine.ts whenever a Payment transitions to 'paid' — the single place
// every fee-payment path (webhook, browser-callback verify, reconciliation) already converges, so
// this never needs to be wired into each payment route separately. Idempotent: a payment can only
// ever transition to 'paid' once (see LEGAL_TRANSITIONS — there's no paid -> paid edge), but this
// still guards on an existing Invoice row directly, so it's safe even if ever called twice.
export async function generateInvoiceForPayment(payment: Payment): Promise<Invoice | null> {
  const existing = await Invoice.findOne({ where: { paymentId: payment.id } });
  if (existing) return existing;

  const seller = sellerDetails();
  const buyer = await resolveBuyer(payment);
  const gstRatePercent = seller.gstin ? Number(process.env.WATTMATCH_GST_RATE_PERCENT || '18') : 0;
  const baseAmountPaise = payment.amountPaise;
  const taxPaise = Math.round((baseAmountPaise * gstRatePercent) / 100);
  const totalPaise = baseAmountPaise + taxPaise;
  const invoiceNumber = `WM/${financialYearLabel(new Date())}/${String(payment.id).padStart(6, '0')}`;
  const purposeLabel = PURPOSE_LABELS[payment.purpose];

  const buffer = await renderInvoicePdf({
    invoiceNumber,
    purposeLabel,
    seller,
    buyer,
    baseAmountPaise,
    gstRatePercent,
    taxPaise,
    totalPaise,
    currency: payment.currency,
  });

  const s3Key = `invoices/${invoiceNumber.replace(/\//g, '-')}.pdf`;
  await uploadObject(s3Key, buffer, 'application/pdf');

  const invoice = await Invoice.create({
    paymentId: payment.id,
    invoiceNumber,
    issuedAt: new Date(),
    sellerName: seller.name,
    sellerGstin: seller.gstin,
    buyerName: buyer.name,
    buyerEmail: buyer.email,
    amountPaise: totalPaise,
    currency: payment.currency,
    s3Key,
  });

  logger.info(
    { paymentId: payment.id, invoiceId: invoice.id, invoiceNumber, isTaxInvoice: Boolean(seller.gstin) },
    '[INVOICE] generated'
  );
  return invoice;
}
