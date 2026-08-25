import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export type EmdSubmissionStatus = 'submitted' | 'released' | 'invoked';

// EMD is a physical/scanned Bank Guarantee, not money — WattMatch never collects or refunds EMD
// cash through Razorpay (see Payment.purpose, which no longer includes 'emd'). A generator uploads
// the instrument + the postal details needed to send it back later; admin marks it released (BG
// physically returned) or invoked (BG claimed with the issuing bank) as an explicit, manual action
// — there is no automatic trigger, since both are real-world actions on a physical document, not a
// state flip a server call can perform on its own.
export class EmdSubmission extends Model<InferAttributes<EmdSubmission>, InferCreationAttributes<EmdSubmission>> {
  declare id: CreationOptional<number>;
  declare tenderId: number;
  declare organizationId: number;

  declare bankName: string;
  declare guaranteeNumber: string;
  declare amountPaise: number;
  declare validUpto: string;

  declare documentS3Key: string;
  declare documentOriginalFilename: string;

  // Where admin sends the instrument back once released — collected up front so release never
  // blocks on chasing the generator for an address after the fact.
  declare returnRecipientName: string;
  declare returnAddressLine: string;
  declare returnCity: string;
  declare returnState: string;
  declare returnPincode: string;
  declare returnPhone: string;

  declare status: CreationOptional<EmdSubmissionStatus>;
  declare resolvedAt: Date | null;
  declare resolvedReason: string | null;
  // Courier/tracking reference, set only on release — optional since not every dispatch method
  // produces one.
  declare dispatchReference: string | null;

  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

EmdSubmission.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    tenderId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    organizationId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

    bankName: { type: DataTypes.STRING, allowNull: false },
    guaranteeNumber: { type: DataTypes.STRING, allowNull: false },
    amountPaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    validUpto: { type: DataTypes.DATEONLY, allowNull: false },

    documentS3Key: { type: DataTypes.STRING, allowNull: false },
    documentOriginalFilename: { type: DataTypes.STRING, allowNull: false },

    returnRecipientName: { type: DataTypes.STRING, allowNull: false },
    returnAddressLine: { type: DataTypes.STRING, allowNull: false },
    returnCity: { type: DataTypes.STRING, allowNull: false },
    returnState: { type: DataTypes.STRING, allowNull: false },
    returnPincode: { type: DataTypes.STRING, allowNull: false },
    returnPhone: { type: DataTypes.STRING, allowNull: false },

    status: { type: DataTypes.ENUM('submitted', 'released', 'invoked'), allowNull: false, defaultValue: 'submitted' },
    resolvedAt: { type: DataTypes.DATE, allowNull: true },
    resolvedReason: { type: DataTypes.STRING, allowNull: true },
    dispatchReference: { type: DataTypes.STRING, allowNull: true },

    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_emd_submissions',
    underscored: true,
    indexes: [{ unique: true, fields: ['tender_id', 'organization_id'] }],
  }
);
