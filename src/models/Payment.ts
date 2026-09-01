import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export type PaymentPurpose = 'rfs_document' | 'bid_processing';
export type PaymentStatus = 'created' | 'attempted' | 'paid' | 'failed' | 'refunded' | 'partially_refunded';

// One model for both remaining real online-payment fee types, distinguished by `purpose` rather
// than one row shape per fee — they share every field that actually matters (amount, order/payment
// ids, status) and forcing separate tables would just be copies of the same state machine. EMD and
// Success Charge used to be Payment purposes too; EMD is now a document (see EmdSubmission) and
// Success Charge is dropped entirely (2026-08-25) — neither is real money moving through Razorpay
// any more. `organizationId` is nullable specifically for `rfs_document`: that
// purchase happens in Stage 3, before any account exists (see Tender.md's Stage 3), so there is no
// organization row yet to reference — `payerName`/`payerEmail` capture identity for that case
// instead, straight from the Stage 3 form.
export class Payment extends Model<InferAttributes<Payment>, InferCreationAttributes<Payment>> {
  declare id: CreationOptional<number>;
  declare purpose: PaymentPurpose;
  declare tenderId: number;
  declare organizationId: number | null;
  declare payerName: string | null;
  declare payerEmail: string | null;
  // Stage 3's structured intake fields (TENDER_WORKFLOW_STAKEHOLDER_PLAN.md) — only ever set for
  // `rfs_document` payments, the one purpose collected before an account exists. Real columns
  // rather than folded into `notes` below, since these are core intake data the plan names
  // explicitly, not incidental free-form context.
  declare payerCompany: string | null;
  declare payerDesignation: string | null;
  declare payerMobile: string | null;
  declare payerIsGenerator: boolean | null;
  // DPDP Act consent (Red Flag #1) — set the moment the Stage 3 form's required consent checkbox
  // is submitted; null means consent was never recorded (never true for a real submission once the
  // form gates on it, but real for any row created before this column existed).
  declare consentGivenAt: Date | null;

  declare razorpayOrderId: string;
  declare razorpayPaymentId: string | null;
  declare razorpaySignature: string | null;
  declare razorpayRefundId: string | null;

  declare amountPaise: number;
  declare currency: string;
  declare status: CreationOptional<PaymentStatus>;
  // Running total of what's actually been refunded so far (Razorpay confirms each refund's own
  // amount independently) — the only way to tell a partial refund from a full one, since a single
  // refund call's amountPaise may cover only part of amountPaise. Compared against amountPaise to
  // decide status: 'refunded' (fully covered) vs 'partially_refunded' (more can still be refunded).
  declare amountRefundedPaise: CreationOptional<number>;

  // Free-form context (e.g. which VettingBid an EMD payment secures) — deliberately untyped, same
  // role as the general prompt's Mongoose `notes: Mixed` field, expressed as a JSON column since
  // Sequelize/MySQL has no schemaless type.
  declare notes: Record<string, unknown> | null;

  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

Payment.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    purpose: { type: DataTypes.ENUM('rfs_document', 'bid_processing'), allowNull: false },
    tenderId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    organizationId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    payerName: { type: DataTypes.STRING, allowNull: true },
    payerEmail: { type: DataTypes.STRING, allowNull: true },
    payerCompany: { type: DataTypes.STRING, allowNull: true },
    payerDesignation: { type: DataTypes.STRING, allowNull: true },
    payerMobile: { type: DataTypes.STRING, allowNull: true },
    payerIsGenerator: { type: DataTypes.BOOLEAN, allowNull: true },
    consentGivenAt: { type: DataTypes.DATE, allowNull: true },

    razorpayOrderId: { type: DataTypes.STRING, allowNull: false, unique: true },
    razorpayPaymentId: { type: DataTypes.STRING, allowNull: true, unique: true },
    razorpaySignature: { type: DataTypes.STRING, allowNull: true },
    razorpayRefundId: { type: DataTypes.STRING, allowNull: true },

    amountPaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    currency: { type: DataTypes.STRING, allowNull: false },
    status: {
      type: DataTypes.ENUM('created', 'attempted', 'paid', 'failed', 'refunded', 'partially_refunded'),
      allowNull: false,
      defaultValue: 'created',
    },
    amountRefundedPaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },

    notes: { type: DataTypes.JSON, allowNull: true },

    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_payments',
    underscored: true,
  }
);
